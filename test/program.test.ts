// A small program with three stores and a clock the tests control.
import { generateKey, type KeyPair } from '../src/keys.js';
import type { Program } from '../src/program.js';
import { MemoryRecorder } from '../src/record.js';
import { Store } from '../src/store.js';
import { Wallet } from '../src/wallet.js';

export class Clock {
  constructor(public t: Date = new Date('2026-04-01T09:00:00Z')) {}
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export const DAY = 86400_000;

export interface Fixture {
  clock: Clock;
  program: Program;
  programJson: string;
  keys: Map<string, KeyPair>;
  stores: Store[];
}

export async function fixture(ids = ['bakery.example', 'cafe.example', 'bookshop.example'], opts: { acceptExpired?: string; start?: Date } = {}): Promise<Fixture> {
  const clock = new Clock(opts.start);
  const keys = new Map<string, KeyPair>();
  for (const id of ids) keys.set(id, await generateKey());
  const program: Program = {
    name: 'arcade.example',
    value: 100,
    validDays: 7,
    stores: ids.map((id) => ({ id, key: (keys.get(id) as KeyPair).publicJwk })),
  };
  const programJson = JSON.stringify(program);
  const stores: Store[] = [];
  for (const id of ids) {
    const s = new Store({
      id,
      privateJwk: (keys.get(id) as KeyPair).privateJwk,
      program,
      programJson,
      recorder: new MemoryRecorder(),
      now: clock.now,
      acceptExpired: opts.acceptExpired === id,
    });
    await s.join();
    stores.push(s);
  }
  return { clock, program, programJson, keys, stores };
}

export async function wallet(): Promise<Wallet> {
  const k = await generateKey();
  return new Wallet(k.privateJwk, k.publicJwk);
}
