import { SignJWT, compactVerify, decodeJwt, decodeProtectedHeader, type JWK } from 'jose';
import { randomId } from './digest.js';
import { VoucherError } from './errors.js';
import { ALG, signingKey, toPublic, verifyingKey } from './keys.js';
import { isOperator, member, vct, type Program } from './program.js';

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
  /**
   * On change only: the voucher it was split from, and the store that
   * issued the original and pays it.
   */
  chg?: Change;
}

export interface Change {
  /** Digest of the voucher this is the rest of. */
  parent: string;
  /** The store that issued the original voucher. */
  origin: string;
}

export const VOUCHER_TYP = 'dc+sd-jwt';

export interface Issuer {
  id: string;
  privateJwk: JWK;
}

/**
 * Issues a voucher to a holder's key: of the program's value, or of `value`
 * when the program earns points from receipts.
 */
export async function issueVoucher(program: Program, issuer: Issuer, holder: JWK, now: Date = new Date(), value: number | undefined = program.value): Promise<string> {
  if (value === undefined) throw new VoucherError('program', 'the program has no fixed value; give the value');
  if (!validValue(program, value)) throw new VoucherError('program', `a voucher of ${value} does not fit the program`);
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
    value,
  };
  const jwt = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG, typ: VOUCHER_TYP, ...(issuer.privateJwk.kid ? { kid: issuer.privateJwk.kid } : {}) })
    .setIssuedAt(iat)
    .setExpirationTime(iat + program.validDays * 86400)
    .sign(await signingKey(issuer.privateJwk));
  return jwt + '~';
}

/**
 * Issues change: the rest of a voucher a customer used part of, to the key
 * the customer named for it. Signed by the operator, worth `value`, valid
 * until the original expires, and naming the original and the store that
 * pays it. Only the operator's registry does this.
 */
export async function issueChange(
  program: Program,
  operatorKey: JWK,
  parent: { digest: string; claims: VoucherClaims },
  holder: JWK,
  value: number,
  now: Date = new Date(),
): Promise<string> {
  const op = program.operator;
  if (!op) throw new VoucherError('program', 'the program names no operator to issue change');
  if (op.key.x !== toPublic(operatorKey).x) throw new VoucherError('issuer', 'the key is not the operator key in the program');
  if (!Number.isInteger(value) || value <= 0) throw new VoucherError('program', `change of ${value}`);
  const origin = parent.claims.chg?.origin ?? parent.claims.iss;
  return (
    (await new SignJWT({
      vct: vct(program),
      iss: op.id,
      jti: randomId(),
      cnf: { jwk: toPublic(holder) },
      program: program.name,
      value,
      chg: { parent: parent.digest, origin },
    })
      .setProtectedHeader({ alg: ALG, typ: VOUCHER_TYP, ...(operatorKey.kid ? { kid: operatorKey.kid } : {}) })
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(parent.claims.exp)
      .sign(await signingKey(operatorKey))) + '~'
  );
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
  const change = isOperator(program, claims.iss);
  const key = change ? program.operator?.key : member(program, claims.iss)?.key;
  if (!key) throw new VoucherError('issuer', `issuer ${claims.iss} is not in the program`);
  try {
    await compactVerify(jwt, await verifyingKey(key));
  } catch {
    throw new VoucherError('issuer', `the signature is not ${claims.iss}'s`);
  }
  if (claims.vct !== vct(program) || claims.program !== program.name) throw new VoucherError('program', 'the voucher does not match the program');
  if (change) {
    // Change is worth whatever was left, and names the store that pays it.
    const c = claims.chg;
    if (!Number.isInteger(claims.value) || (claims.value as number) <= 0) throw new VoucherError('program', 'change must be worth a positive whole number');
    if (typeof c?.parent !== 'string' || !/^[0-9a-f]{64}$/.test(c.parent) || typeof c.origin !== 'string' || !member(program, c.origin)) {
      throw new VoucherError('format', 'change must name the voucher it was split from and a store of the program');
    }
  } else {
    if (claims.chg !== undefined) throw new VoucherError('format', 'only the operator issues change');
    if (!validValue(program, claims.value)) throw new VoucherError('program', 'the voucher does not match the program');
  }
  if (typeof claims.jti !== 'string' || typeof claims.iat !== 'number' || typeof claims.exp !== 'number' || typeof claims.cnf?.jwk !== 'object') {
    throw new VoucherError('format', 'jti, iat, exp and cnf.jwk are required');
  }
  if (opts.at && opts.at.getTime() / 1000 > claims.exp) {
    throw new VoucherError('expired', `expired at ${new Date(claims.exp * 1000).toISOString()}`);
  }
  return claims as VoucherClaims;
}

/**
 * Whether a voucher may carry `value`: the program's fixed value, or, when
 * the program earns points from receipts, any positive integer. The store
 * that signs a voucher pays it, so the program does not cap it.
 */
export function validValue(program: Program, value: unknown): value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) return false;
  return program.earn !== undefined || value === program.value;
}
