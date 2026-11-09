// Receipts as the evidence of a purchase. A customer claims points with a
// receipt; the store that printed it signs the voucher. Two kinds:
//
//   - a printed receipt, read by the customer's app: store, time, number and
//     total, confirmed by the store against its sales once a day;
//   - a receipt with a signed QR, which a point of sale prints: the store's
//     approval in advance, issued without review.
//
// Either way, a receipt is claimed once: the first claim wins, later ones
// are refused as duplicates.
import { SignJWT, compactVerify, decodeJwt, decodeProtectedHeader, type JWK } from 'jose';
import { VoucherError } from './errors.js';
import { ALG, signingKey, toPublic, verifyingKey } from './keys.js';
import { earned, member, type Program } from './program.js';
import type { Issuer } from './voucher.js';

/** A receipt as printed. */
export interface Receipt {
  store: string;
  /** Time of purchase as printed, in local time: `YYYY-MM-DDTHH:MM`. */
  at: string;
  /** The receipt number as printed, with the register where numbers are per register. */
  number: string;
  /** The total paid, in the currency's smallest unit (yen). */
  total: number;
}

export const RECEIPT_TYP = 'kangoh-receipt+jwt';
export const STORE_TYP = 'kangoh-store+jwt';
/** Audience of the tokens stores sign for the operator's service. */
export const SERVICE_AUD = 'kangoh-service';

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Checks a receipt's fields, returning it with the number normalized. */
export function checkReceipt(r: Partial<Receipt>): Receipt {
  if (typeof r.store !== 'string' || !r.store) throw new VoucherError('format', 'receipt: store is required');
  if (typeof r.at !== 'string' || !AT.test(r.at) || Number.isNaN(Date.parse(r.at + ':00Z'))) throw new VoucherError('format', 'receipt: at must be YYYY-MM-DDTHH:MM');
  const number = normalizeNumber(String(r.number ?? ''));
  if (!number || number.length > 64) throw new VoucherError('format', 'receipt: number is required, at most 64 characters');
  if (!Number.isInteger(r.total) || (r.total as number) <= 0) throw new VoucherError('format', 'receipt: total must be a positive integer');
  return { store: r.store, at: r.at, number, total: r.total as number };
}

/** A receipt number as compared: full-width characters folded, spaces removed, upper case. */
export function normalizeNumber(n: string): string {
  return n.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

/** What makes two claims the same receipt: the store, the day of purchase and the number. */
export function receiptKey(r: Receipt): string {
  return `${r.store}|${r.at.slice(0, 10)}|${normalizeNumber(r.number)}`;
}

/**
 * Signs the QR a point of sale prints on a receipt: the store's approval of
 * a voucher of `value` (by default what the total earns) to whoever claims
 * the receipt first. It holds no points itself; the voucher is issued to the
 * claimant's key when the store's tool next syncs.
 */
export async function signReceipt(program: Program, issuer: Issuer, receipt: Omit<Receipt, 'store'>, opts: { value?: number; now?: Date } = {}): Promise<string> {
  const m = member(program, issuer.id);
  if (!m) throw new VoucherError('issuer', `${issuer.id} is not in the program`);
  if (m.key.x !== toPublic(issuer.privateJwk).x) throw new VoucherError('issuer', `the key of ${issuer.id} is not the one in the program`);
  const r = checkReceipt({ ...receipt, store: issuer.id });
  const value = opts.value ?? earned(program, r.total);
  if (!Number.isInteger(value) || value <= 0) throw new VoucherError('program', `a receipt of ${r.total} earns no points`);
  return new SignJWT({ program: program.name, rcpt: { at: r.at, number: r.number, total: r.total }, value })
    .setProtectedHeader({ alg: ALG, typ: RECEIPT_TYP })
    .setIssuer(issuer.id)
    .setIssuedAt(Math.floor((opts.now ?? new Date()).getTime() / 1000))
    .sign(await signingKey(issuer.privateJwk));
}

/** Verifies a receipt QR against the program: signed by a member, for this program. */
export async function verifyReceipt(program: Program, token: string): Promise<{ receipt: Receipt; value: number }> {
  let header;
  let c: { iss?: string; program?: string; rcpt?: Partial<Receipt>; value?: number };
  try {
    header = decodeProtectedHeader(token);
    c = decodeJwt(token);
  } catch (e) {
    throw new VoucherError('format', `receipt QR is not a JWT: ${(e as Error).message}`);
  }
  if (header.typ !== RECEIPT_TYP || header.alg !== ALG) throw new VoucherError('format', `receipt QR must be ${RECEIPT_TYP} signed with ${ALG}`);
  const m = typeof c.iss === 'string' ? member(program, c.iss) : undefined;
  if (!m) throw new VoucherError('issuer', `receipt QR from ${c.iss}, who is not in the program`);
  try {
    await compactVerify(token, await verifyingKey(m.key));
  } catch {
    throw new VoucherError('issuer', `the receipt QR is not signed by ${m.id}`);
  }
  if (c.program !== program.name) throw new VoucherError('program', 'the receipt QR is for another program');
  if (!Number.isInteger(c.value) || (c.value as number) <= 0) throw new VoucherError('format', 'the receipt QR has no value');
  return { receipt: checkReceipt({ ...(c.rcpt ?? {}), store: m.id }), value: c.value as number };
}

/** What a printed QR contains: the token, as a link to the operator's service when the program names one. */
export function receiptQr(program: Program, token: string): string {
  return program.service ? `${program.service.replace(/\/$/, '')}/r#${token}` : token;
}

/** Reads a scanned receipt QR: the token, and the service it names, if any. */
export function parseReceiptQr(text: string): { token: string; service?: string } {
  const t = text.trim();
  const hash = t.indexOf('#');
  if (/^https?:\/\//.test(t) && hash > 0) {
    const url = new URL(t.slice(0, hash));
    const service = url.origin + url.pathname.replace(/\/r$/, '');
    return { token: t.slice(hash + 1), service };
  }
  return { token: t };
}

/** A short-lived token a store signs to read and answer its claims at the operator's service. */
export async function storeToken(storeId: string, privateJwk: JWK, now: Date = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG, typ: STORE_TYP })
    .setIssuer(storeId)
    .setAudience(SERVICE_AUD)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(await signingKey(privateJwk));
}

/** Verifies a store token, returning the store it speaks for. */
export async function verifyStoreToken(program: Program, token: string, now: Date = new Date()): Promise<string> {
  let c: { iss?: string; aud?: string | string[]; exp?: number; iat?: number };
  try {
    if (decodeProtectedHeader(token).typ !== STORE_TYP) throw new Error(`typ is not ${STORE_TYP}`);
    c = decodeJwt(token);
  } catch (e) {
    throw new VoucherError('format', `store token: ${(e as Error).message}`);
  }
  const m = typeof c.iss === 'string' ? member(program, c.iss) : undefined;
  if (!m) throw new VoucherError('issuer', `store token from ${c.iss}, who is not in the program`);
  try {
    await compactVerify(token, await verifyingKey(m.key));
  } catch {
    throw new VoucherError('issuer', `the store token is not signed by ${m.id}`);
  }
  const t = now.getTime() / 1000;
  if (c.aud !== SERVICE_AUD) throw new VoucherError('audience', 'the store token is for another service');
  if (typeof c.exp !== 'number' || t > c.exp || typeof c.iat !== 'number' || c.iat > t + 60) throw new VoucherError('expired', 'the store token has expired');
  return m.id;
}
