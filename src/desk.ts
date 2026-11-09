// The operator's receipt desk: where customers' apps leave receipt claims
// and stores answer them. It signs nothing and decides nothing. A store
// signs every voucher with its own key, after confirming the day's claims
// against its sales, or in advance with the QR it printed.
//
// A receipt is claimed once. The first claim for a store, day and number
// wins; later ones are refused as duplicates and the refusal is recorded,
// so that the customer can see why. A customer who really made the purchase
// takes the receipt to the store, which issues at the counter instead.
//
// Two files:
//   state   the events, private to the operator: receipts in the clear,
//           holder keys, vouchers until fetched. Replayed on start.
//   chain   the outcomes, public: a deedlog chain (spec/evidence-chain.md)
//           whose records point to the state lines by digest and carry the
//           claim, the store, an HMAC of the receipt and the status. No
//           totals and no keys, so that publishing it leaks no sales.
//           Checkpoint and serve it with dlog.
import { createHmac } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import type { JWK } from 'jose';
import { randomId, sha256 } from './digest.js';
import { VoucherError } from './errors.js';
import { DEFAULT_RECEIPT_DAYS, earned, member, type Program } from './program.js';
import { checkReceipt, receiptKey, verifyReceipt, type Receipt } from './receipt.js';
import { VERSION } from './version.js';
import { verifyVoucher } from './voucher.js';

export type ClaimStatus = 'pending' | 'authorized' | 'issued' | 'rejected' | 'duplicate';

export interface ReceiptClaim {
  id: string;
  /** When the claim was made, RFC 3339 UTC. */
  submitted: string;
  store: string;
  receipt: Receipt;
  /**
   * `pending`: waits for the store's daily review. `authorized`: came with
   * the store's signed QR, issued at the store's next sync without review.
   * `duplicate`: refused, the receipt was claimed first by `duplicateOf`.
   */
  status: ClaimStatus;
  /** The key the voucher is to be bound to; a fresh one per claim. Absent on duplicates. */
  holder?: JWK;
  /** The points the claim is for: what the total earns, or what the signed QR says. */
  value: number;
  signed: boolean;
  duplicateOf?: string;
  reason?: string;
  /** The voucher, once issued. */
  voucher?: string;
  /** When the store answered. */
  decided?: string;
}

/** An error with the HTTP status the service answers with. */
export class DeskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DeskError';
  }
}

export interface ReceiptDeskOptions {
  program: Program;
  /** Key of the HMAC under which receipts appear in the public chain. Keep it secret: receipt numbers and dates are guessable. */
  secret: string;
  /** The events file (private). */
  state?: string;
  /** The outcomes chain (public), in deedlog's format. */
  chain?: string;
  now?: () => Date;
}

type Event =
  | { ev: 'submitted'; at: string; claim: ReceiptClaim }
  | { ev: 'issued'; at: string; id: string; voucher: string; value: number }
  | { ev: 'rejected'; at: string; id: string; reason: string };

export class ReceiptDesk {
  private readonly claims = new Map<string, ReceiptClaim>();
  private readonly firstByReceipt = new Map<string, string>();
  private readonly program: Program;
  private readonly now: () => Date;
  private chainSeq = 0;
  private chainPrev: string | undefined;

  constructor(readonly opts: ReceiptDeskOptions) {
    if (!opts.secret) throw new Error('the receipt desk needs a secret');
    this.program = opts.program;
    this.now = opts.now ?? (() => new Date());
  }

  /** Replays the state file and finds the end of the chain. */
  async load(): Promise<void> {
    for (const line of await lines(this.opts.state)) this.apply(JSON.parse(line) as Event);
    const chain = await lines(this.opts.chain);
    this.chainSeq = chain.length;
    const last = chain[chain.length - 1];
    if (last !== undefined) this.chainPrev = 'sha256:' + sha256(last);
  }

  get size(): number {
    return this.claims.size;
  }

  /**
   * Takes a claim: a printed receipt, or a signed receipt QR, with the key
   * the voucher is to be bound to. Returns the claim; a duplicate comes back
   * with status `duplicate` and is recorded as refused.
   */
  async submit(input: { receipt?: Partial<Receipt>; token?: string; holder?: JWK }): Promise<ReceiptClaim> {
    const holder = checkHolder(input.holder);
    let receipt: Receipt;
    let value: number;
    let signed = false;
    try {
      if (input.token) {
        ({ receipt, value } = await verifyReceipt(this.program, input.token));
        signed = true;
      } else {
        receipt = checkReceipt(input.receipt ?? {});
        const m = member(this.program, receipt.store);
        if (!m) throw new DeskError(422, `${receipt.store} is not in the program`);
        if (m.receipts === 'signed') throw new DeskError(422, `${receipt.store} prints a QR on its receipts; scan the QR instead`);
        value = earned(this.program, receipt.total);
        if (value <= 0) throw new DeskError(422, `a receipt of ${receipt.total} earns no points`);
      }
    } catch (e) {
      if (e instanceof VoucherError) throw new DeskError(422, e.message);
      throw e;
    }
    this.checkDate(receipt);
    const at = this.now().toISOString();
    const claim: ReceiptClaim = { id: randomId(), submitted: at, store: receipt.store, receipt, status: signed ? 'authorized' : 'pending', holder, value, signed };
    const first = this.firstByReceipt.get(receiptKey(receipt));
    if (first) {
      const prior = this.claims.get(first) as ReceiptClaim;
      delete claim.holder;
      claim.status = 'duplicate';
      claim.duplicateOf = first;
      claim.reason = `the receipt was claimed first at ${prior.submitted}`;
    }
    await this.record({ ev: 'submitted', at, claim });
    return { ...claim };
  }

  get(id: string): ReceiptClaim | undefined {
    const c = this.claims.get(id);
    return c ? { ...c } : undefined;
  }

  /** A store's claims submitted on or after `from` (YYYY-MM-DD, UTC), oldest first. */
  list(store: string, from?: string): ReceiptClaim[] {
    return [...this.claims.values()].filter((c) => c.store === store && (!from || c.submitted.slice(0, 10) >= from)).map((c) => ({ ...c }));
  }

  /** The store answers a claim with the voucher it signed. */
  async issue(store: string, id: string, voucher: string): Promise<ReceiptClaim> {
    const c = this.open(store, id);
    let claims;
    try {
      claims = await verifyVoucher(this.program, voucher, { at: this.now() });
    } catch (e) {
      throw new DeskError(422, (e as Error).message);
    }
    if (claims.iss !== store) throw new DeskError(422, `the voucher is signed by ${claims.iss}, not ${store}`);
    if (claims.cnf.jwk.x !== c.holder?.x) throw new DeskError(422, "the voucher is not bound to the claim's key");
    await this.record({ ev: 'issued', at: this.now().toISOString(), id, voucher, value: claims.value });
    return this.get(id) as ReceiptClaim;
  }

  /** The store refuses a claim, with the reason the customer will see. */
  async reject(store: string, id: string, reason: string): Promise<ReceiptClaim> {
    this.open(store, id);
    const r = reason.trim().slice(0, 200);
    if (!r) throw new DeskError(400, 'a reason is required');
    await this.record({ ev: 'rejected', at: this.now().toISOString(), id, reason: r });
    return this.get(id) as ReceiptClaim;
  }

  /** The HMAC under which a receipt appears in the public chain. */
  receiptDigest(r: Receipt): string {
    return createHmac('sha256', this.opts.secret).update(receiptKey(r)).digest('hex');
  }

  private open(store: string, id: string): ReceiptClaim {
    const c = this.claims.get(id);
    if (!c || c.store !== store) throw new DeskError(404, `no claim ${id} for ${store}`);
    if (c.status !== 'pending' && c.status !== 'authorized') throw new DeskError(409, `claim ${id} is ${c.status}`);
    return c;
  }

  private checkDate(r: Receipt): void {
    const days = this.program.receiptDays ?? DEFAULT_RECEIPT_DAYS;
    // The receipt's time is local and has no zone; a day either side covers any.
    const bought = Date.parse(r.at + ':00Z');
    const now = this.now().getTime();
    if (bought > now + 86400_000) throw new DeskError(422, `the receipt is dated ${r.at}, in the future`);
    if (bought < now - (days + 1) * 86400_000) throw new DeskError(422, `the receipt is dated ${r.at}; receipts can be claimed for ${days} days`);
  }

  private apply(e: Event): void {
    switch (e.ev) {
      case 'submitted': {
        this.claims.set(e.claim.id, { ...e.claim });
        const key = receiptKey(e.claim.receipt);
        if (e.claim.status !== 'duplicate' && !this.firstByReceipt.has(key)) this.firstByReceipt.set(key, e.claim.id);
        break;
      }
      case 'issued': {
        const c = this.claims.get(e.id);
        if (c) Object.assign(c, { status: 'issued', voucher: e.voucher, value: e.value, decided: e.at });
        break;
      }
      case 'rejected': {
        const c = this.claims.get(e.id);
        if (c) Object.assign(c, { status: 'rejected', reason: e.reason, decided: e.at });
        break;
      }
    }
  }

  /** Applies an event, appends it to the state file, and its outcome to the chain. */
  private async record(e: Event): Promise<void> {
    this.apply(e);
    const line = JSON.stringify(e);
    if (this.opts.state) await appendFile(this.opts.state, line + '\n');
    const c = this.claims.get(e.ev === 'submitted' ? e.claim.id : e.id) as ReceiptClaim;
    // The public outcome: which claim, whose receipt (keyed), what became of
    // it. A store's reason for a rejection is free text and may quote the
    // receipt, so it stays in the state, where the claimant reads it.
    const meta: { [k: string]: string } = { claim: c.id, store: c.store, receipt: this.receiptDigest(c.receipt), status: c.status };
    if (c.duplicateOf) {
      meta.duplicate_of = c.duplicateOf;
      if (c.reason) meta.reason = c.reason;
    }
    const record = {
      spec: 'deedlog/v0.1',
      chain: `${this.program.name}/receipts`,
      seq: this.chainSeq,
      ...(this.chainPrev ? { prev: this.chainPrev } : {}),
      collected_at: e.at.replace(/\.\d{3}Z$/, 'Z'),
      source: { type: 'kangoh-receipts', id: this.program.name, collector: `kangoh/${VERSION}` },
      subject: { media_type: 'application/json', size: Buffer.byteLength(line), digest: { sha256: sha256(line) } },
      meta,
    };
    const out = JSON.stringify(record);
    if (this.opts.chain) await appendFile(this.opts.chain, out + '\n');
    this.chainSeq++;
    this.chainPrev = 'sha256:' + sha256(out);
  }
}

function checkHolder(h: JWK | undefined): JWK {
  if (!h || h.kty !== 'OKP' || h.crv !== 'Ed25519' || typeof h.x !== 'string' || 'd' in h) {
    throw new DeskError(422, 'holder must be a public Ed25519 JWK');
  }
  return { kty: h.kty, crv: h.crv, x: h.x };
}

async function lines(path: string | undefined): Promise<string[]> {
  if (!path) return [];
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** What a customer's app sees of its claim: no other claim's id, no keys. */
export function claimView(c: ReceiptClaim): Omit<ReceiptClaim, 'holder' | 'duplicateOf'> {
  const { holder: _h, duplicateOf: _d, ...rest } = c;
  return rest;
}
