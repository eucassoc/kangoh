import { SignJWT, compactVerify, decodeJwt, decodeProtectedHeader, type JWK } from 'jose';
import { randomId } from './digest.js';
import { VoucherError } from './errors.js';
import { ALG, signingKey, toPublic, verifyingKey } from './keys.js';
import { member, vct, type Program } from './program.js';

/**
 * A voucher is an SD-JWT VC (draft-ietf-oauth-sd-jwt-vc) with no selective
 * disclosures: the issuer's JWT followed by `~`. Every claim is needed to
 * accept it, so nothing is hidden, and the format stays what wallets and
 * verifiers already speak.
 */
export interface VoucherClaims {
  vct: string;
  /** The issuing store. */
  iss: string;
  jti: string;
  iat: number;
  exp: number;
  /** The holder's key; a presentation must be signed with it. */
  cnf: { jwk: JWK };
  program: string;
  value: number;
}

export const VOUCHER_TYP = 'dc+sd-jwt';

export interface Issuer {
  id: string;
  privateJwk: JWK;
}

/** Issues a voucher of the program's value to a holder's key. */
export async function issueVoucher(program: Program, issuer: Issuer, holder: JWK, now: Date = new Date()): Promise<string> {
  const m = member(program, issuer.id);
  if (!m) throw new VoucherError('issuer', `${issuer.id} is not in the program`);
  const pub = toPublic(issuer.privateJwk);
  if (m.key.x !== pub.x) throw new VoucherError('issuer', `the key of ${issuer.id} is not the one in the program`);
  const iat = Math.floor(now.getTime() / 1000);
  const claims: Omit<VoucherClaims, 'iat' | 'exp'> = {
    vct: vct(program),
    iss: issuer.id,
    jti: randomId(),
    cnf: { jwk: toPublic(holder) },
    program: program.name,
    value: program.value,
  };
  const jwt = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG, typ: VOUCHER_TYP, ...(issuer.privateJwk.kid ? { kid: issuer.privateJwk.kid } : {}) })
    .setIssuedAt(iat)
    .setExpirationTime(iat + program.validDays * 86400)
    .sign(await signingKey(issuer.privateJwk));
  return jwt + '~';
}

/** Splits a voucher, or a presentation, into the issuer's JWT and the rest. */
export function splitVoucher(s: string): { jwt: string; voucher: string; kb: string } {
  const end = s.lastIndexOf('~');
  if (end < 0) throw new VoucherError('format', 'not an SD-JWT: no "~"');
  const voucher = s.slice(0, end + 1);
  const parts = voucher.slice(0, -1).split('~');
  if (parts.length !== 1 || !parts[0]) throw new VoucherError('format', 'disclosures are not used in vouchers');
  return { jwt: parts[0], voucher, kb: s.slice(end + 1) };
}

/**
 * Verifies a voucher against the program: the issuer is a member, the
 * signature is the issuer's, and the claims match the program. With `at`,
 * the voucher must not have expired at that time; without it, expiry is
 * left to the caller, as settlement checks it against the redemption time.
 */
export async function verifyVoucher(program: Program, s: string, opts: { at?: Date } = {}): Promise<VoucherClaims> {
  const { jwt } = splitVoucher(s);
  let header;
  let claims: Partial<VoucherClaims>;
  try {
    header = decodeProtectedHeader(jwt);
    claims = decodeJwt(jwt) as Partial<VoucherClaims>;
  } catch (e) {
    throw new VoucherError('format', `not a JWT: ${(e as Error).message}`);
  }
  if (header.typ !== VOUCHER_TYP && header.typ !== 'vc+sd-jwt') throw new VoucherError('format', `typ ${header.typ} is not ${VOUCHER_TYP}`);
  if (header.alg !== ALG) throw new VoucherError('format', `alg ${header.alg} is not ${ALG}`);
  if (typeof claims.iss !== 'string') throw new VoucherError('format', 'no issuer');
  const m = member(program, claims.iss);
  if (!m) throw new VoucherError('issuer', `issuer ${claims.iss} is not in the program`);
  try {
    await compactVerify(jwt, await verifyingKey(m.key));
  } catch {
    throw new VoucherError('issuer', `the signature is not ${claims.iss}'s`);
  }
  if (claims.vct !== vct(program) || claims.program !== program.name || claims.value !== program.value) {
    throw new VoucherError('program', 'the voucher does not match the program');
  }
  if (typeof claims.jti !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || typeof claims.cnf?.jwk !== 'object') {
    throw new VoucherError('format', 'jti, iat, exp and cnf.jwk are required');
  }
  if (opts.at && opts.at.getTime() / 1000 > claims.exp) {
    throw new VoucherError('expired', `expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }
  return claims as VoucherClaims;
}
