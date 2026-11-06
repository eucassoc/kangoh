import type { JWK } from 'jose';
import { randomId, sha256 } from './digest.js';
import { VoucherError } from './errors.js';
import { verifyPresentation, type Presented } from './presentation.js';
import type { Program } from './program.js';
import type { Record, Recorder } from './record.js';
import { issueVoucher } from './voucher.js';

export interface StoreOptions {
  id: string;
  privateJwk: JWK;
  program: Program;
  /** The program exactly as published; its digest is the store's first record. */
  programJson: string;
  recorder: Recorder;
  now?: () => Date;
  /** Accept vouchers after they expired. Settlement will not pay them. */
  acceptExpired?: boolean;
}

export interface Redemption extends Presented {
  record: Record;
  /** Digest of the voucher, the key under which it is settled. */
  voucherDigest: string;
}

/** What a store submits for settlement: its records and the presentations it took. */
export interface Claim {
  store: string;
  records: Record[];
  /** Presentations by the digest in their record. */
  presentations: { [digest: string]: string };
}

/**
 * The store side: the point of sale calls `issue` after a purchase and
 * `redeem` when a voucher is presented. The store keeps its signing key,
 * its records and the presentations it took. It keeps nothing about
 * customers, and looks nothing up at the counter beyond the program.
 */
export class Store {
  readonly id: string;
  private readonly privateJwk: JWK;
  private readonly program: Program;
  private readonly programJson: string;
  private readonly recorder: Recorder;
  private readonly now: () => Date;
  private readonly acceptExpired: boolean;
  private readonly challenges = new Set<string>();
  private readonly taken = new Set<string>();
  private readonly presentations: { [digest: string]: string } = {};

  constructor(opts: StoreOptions) {
    this.id = opts.id;
    this.privateJwk = opts.privateJwk;
    this.program = opts.program;
    this.programJson = opts.programJson;
    this.recorder = opts.recorder;
    this.now = opts.now ?? (() => new Date());
    this.acceptExpired = opts.acceptExpired ?? false;
  }

  /** Records the program. It must be the first record. */
  async join(): Promise<Record> {
    if ((await this.recorder.records()).length) throw new Error('join must come before any other record');
    return this.recorder.append({ at: this.now().toISOString(), event: 'program', digest: sha256(this.programJson) });
  }

  /** Issues a voucher to a holder's key and records its digest. The voucher goes to the holder. */
  async issue(holder: JWK): Promise<string> {
    const v = await issueVoucher(this.program, { id: this.id, privateJwk: this.privateJwk }, holder, this.now());
    await this.recorder.append({ at: this.now().toISOString(), event: 'issued', digest: sha256(v) });
    return v;
  }

  /** A challenge for one presentation. */
  challenge(): string {
    const c = randomId();
    this.challenges.add(c);
    return c;
  }

  /**
   * Accepts a presentation and records it. The checks are the issuer's
   * signature, the holder's signature, the challenge, the expiry, and that
   * this store has not taken the voucher before. Whether another store has
   * is found at settlement.
   */
  async redeem(presentation: string): Promise<Redemption> {
    const now = this.now();
    const p = await verifyPresentation(this.program, presentation, { aud: this.id, ...(this.acceptExpired ? {} : { at: now }) });
    if (!this.challenges.delete(p.kb.nonce)) throw new VoucherError('nonce', 'unknown or reused challenge');
    const voucherDigest = sha256(p.voucher);
    if (this.taken.has(voucherDigest)) throw new VoucherError('nonce', 'already redeemed here');
    this.taken.add(voucherDigest);
    const digest = sha256(presentation);
    const record = await this.recorder.append({
      at: now.toISOString(),
      event: 'redeemed',
      digest,
      meta: { voucher: voucherDigest, issuer: p.claims.iss },
    });
    this.presentations[digest] = presentation;
    return { ...p, record, voucherDigest };
  }

  /** The store's claim for settlement. */
  async claim(): Promise<Claim> {
    return { store: this.id, records: await this.recorder.records(), presentations: { ...this.presentations } };
  }
}
