import { SignJWT, compactVerify, decodeJwt, decodeProtectedHeader, type JWK } from 'jose';
import { sha256b64url } from './digest.js';
import { VoucherError } from './errors.js';
import { ALG, signingKey, verifyingKey } from './keys.js';
import type { Program } from './program.js';
import { splitVoucher, verifyVoucher, type VoucherClaims } from './voucher.js';

/**
 * A presentation is the voucher followed by a key binding JWT signed with
 * the holder's key, naming the store (`aud`) and the store's challenge
 * (`nonce`), so that a copied voucher is worthless without the key and a
 * presentation cannot be replayed to another store.
 */
export const KB_TYP = 'kb+jwt';

export interface KeyBinding {
  iat: number;
  aud: string;
  nonce: string;
  sd_hash: string;
}

export interface Presented {
  /** The voucher as issued. */
  voucher: string;
  claims: VoucherClaims;
  kb: KeyBinding;
}

/** Signs a presentation of a voucher to a store. */
export async function present(voucher: string, holder: JWK, aud: string, nonce: string, now: Date = new Date()): Promise<string> {
  const { voucher: v } = splitVoucher(voucher);
  const kb = await new SignJWT({ nonce, sd_hash: sha256b64url(v) })
    .setProtectedHeader({ alg: ALG, typ: KB_TYP })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setAudience(aud)
    .sign(await signingKey(holder));
  return v + kb;
}

/**
 * Verifies a presentation: the voucher against the program, and the key
 * binding against the voucher's holder key, the store and, if given, the
 * challenge. Expiry is checked at `at` when given.
 */
export async function verifyPresentation(program: Program, s: string, opts: { aud: string; nonce?: string; at?: Date }): Promise<Presented> {
  const { voucher, kb } = splitVoucher(s);
  if (!kb) throw new VoucherError('holder', 'no key binding: the voucher was not presented by its holder');
  const claims = await verifyVoucher(program, voucher, opts.at ? { at: opts.at } : {});
  let header;
  let payload: Partial<KeyBinding>;
  try {
    header = decodeProtectedHeader(kb);
    payload = decodeJwt(kb) as Partial<KeyBinding>;
  } catch (e) {
    throw new VoucherError('format', `key binding is not a JWT: ${(e as Error).message}`);
  }
  if (header.typ !== KB_TYP) throw new VoucherError('format', `key binding typ ${header.typ} is not ${KB_TYP}`);
  try {
    await compactVerify(kb, await verifyingKey(claims.cnf.jwk));
  } catch {
    throw new VoucherError('holder', 'the presentation is not signed by the holder of the voucher');
  }
  if (payload.sd_hash !== sha256b64url(voucher)) throw new VoucherError('holder', 'the key binding is for another voucher');
  if (payload.aud !== opts.aud) throw new VoucherError('audience', `presented to ${payload.aud}, not to ${opts.aud}`);
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw new VoucherError('nonce', 'the challenge does not match');
  if (typeof payload.iat !== 'number' || typeof payload.nonce !== 'string') throw new VoucherError('format', 'key binding needs iat and nonce');
  return { voucher, claims, kb: payload as KeyBinding };
}
