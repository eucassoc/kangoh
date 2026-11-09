import type { JWK } from 'jose';

/**
 * A program is what the operator publishes: the stores that take part, with
 * the keys they issue vouchers with, what a voucher is worth and how long it
 * is valid. Stores and agents verify everything against it and nothing else.
 */
export interface Program {
  /** Name of the program; the `program` claim of every voucher. */
  name: string;
  /** Value of a voucher a store issues at the counter, in the program's unit. Required unless `earn` is given. */
  value?: number;
  /** Points earned from a receipt. With it, a voucher may carry any positive value: the store that signs it pays it. */
  earn?: Earn;
  /** Days a voucher is valid from issuance. */
  validDays: number;
  /** Days after the purchase within which a receipt can be claimed. 7 when not given. */
  receiptDays?: number;
  /** Base URL of the operator's service: the registry and the receipt desk. */
  service?: string;
  /** Verifiable credential type (`vct`) of the vouchers. */
  vct?: string;
  stores: Member[];
}

/** `points` for every `per` of a receipt's total, up to `max` per receipt. */
export interface Earn {
  per: number;
  points: number;
  max?: number;
}

export interface Member {
  id: string;
  /** Public JWK the store signs vouchers with. */
  key: JWK;
  /**
   * How the store's receipts are claimed. `review` (the default): from what
   * is printed on the receipt, and the store confirms the day's claims
   * against its sales once a day. `signed`: the store prints a signed QR on
   * every receipt, the QR is the store's approval in advance and nothing is
   * reviewed; claims without it are refused.
   */
  receipts?: 'review' | 'signed';
}

export const DEFAULT_VCT = 'https://kangoh.com/voucher';
export const DEFAULT_RECEIPT_DAYS = 7;

export function vct(program: Program): string {
  return program.vct ?? DEFAULT_VCT;
}

export function member(program: Program, id: string): Member | undefined {
  return program.stores.find((m) => m.id === id);
}

/** The points a receipt of `total` earns under the program; 0 when it earns none. */
export function earned(program: Program, total: number): number {
  const e = program.earn;
  if (!e || !Number.isFinite(total) || total <= 0) return 0;
  const points = Math.floor(total / e.per) * e.points;
  return e.max !== undefined ? Math.min(points, e.max) : points;
}

/** Parses a published program and checks its shape. */
export function parseProgram(json: string): Program {
  const p = JSON.parse(json) as Partial<Program>;
  const positive = (v: unknown) => Number.isInteger(v) && (v as number) > 0;
  if (typeof p.name !== 'string' || !p.name) throw new Error('program: name is required');
  if (p.value !== undefined && !positive(p.value)) throw new Error('program: value must be a positive integer');
  if (p.earn !== undefined) {
    const e = p.earn as Partial<Earn>;
    if (!positive(e.per) || !positive(e.points) || (e.max !== undefined && !positive(e.max))) {
      throw new Error('program: earn needs per and points as positive integers, and max if given');
    }
  }
  if (p.value === undefined && p.earn === undefined) throw new Error('program: value or earn is required');
  if (!positive(p.validDays)) throw new Error('program: validDays must be a positive integer');
  if (p.receiptDays !== undefined && !positive(p.receiptDays)) throw new Error('program: receiptDays must be a positive integer');
  if (p.service !== undefined && (typeof p.service !== 'string' || !/^https?:\/\//.test(p.service))) throw new Error('program: service must be an http(s) URL');
  if (!Array.isArray(p.stores) || p.stores.length === 0) throw new Error('program: stores is required');
  for (const m of p.stores) {
    if (typeof m?.id !== 'string' || !m.id || typeof m.key !== 'object') throw new Error('program: every store needs an id and a key');
    if (m.receipts !== undefined && m.receipts !== 'review' && m.receipts !== 'signed') throw new Error(`program: receipts of ${m.id} must be review or signed`);
  }
  return p as Program;
}
