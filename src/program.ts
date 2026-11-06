import type { JWK } from 'jose';

/**
 * A program is what the operator publishes: the stores that take part, with
 * the keys they issue vouchers with, the value of one voucher and how long it
 * is valid. Stores and agents verify everything against it and nothing else.
 */
export interface Program {
  /** Name of the program; the `program` claim of every voucher. */
  name: string;
  /** Value of one voucher, in the program's unit. */
  value: number;
  /** Days a voucher is valid from issuance. */
  validDays: number;
  /** Verifiable credential type (`vct`) of the vouchers. */
  vct?: string;
  stores: Member[];
}

export interface Member {
  id: string;
  /** Public JWK the store signs vouchers with. */
  key: JWK;
}

export const DEFAULT_VCT = 'https://github.com/joeartsea/RaaS/voucher';

export function vct(program: Program): string {
  return program.vct ?? DEFAULT_VCT;
}

export function member(program: Program, id: string): Member | undefined {
  return program.stores.find((m) => m.id === id);
}

/** Parses a published program and checks its shape. */
export function parseProgram(json: string): Program {
  const p = JSON.parse(json) as Partial<Program>;
  if (typeof p.name !== 'string' || !p.name) throw new Error('program: name is required');
  if (!Number.isInteger(p.value) || (p.value as number) <= 0) throw new Error('program: value must be a positive integer');
  if (!Number.isInteger(p.validDays) || (p.validDays as number) <= 0) throw new Error('program: validDays must be a positive integer');
  if (!Array.isArray(p.stores) || p.stores.length === 0) throw new Error('program: stores is required');
  for (const m of p.stores) {
    if (typeof m?.id !== 'string' || !m.id || typeof m.key !== 'object') throw new Error('program: every store needs an id and a key');
  }
  return p as Program;
}
