import type { JWK } from 'jose';
import { randomId, sha256 } from './digest.js';
import { VoucherError } from './errors.js';
import { verifyPresentation, type Presented } from './presentation.js';
import type { Program } from './program.js';
import type { Record, Recorder } from './record.js';
import { issueVoucher } from './voucher.js';
import { RegistryClient, type RegistryClientOptions } from './registry.js';

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
  /** Where the presentations the store took are kept. In memory by default; a store keeps them on disk, as they are its claim. */
  presentations?: PresentationStore;
  /** The operator's registry, asked before a voucher is taken whether another store has it. Without it, a double use is found at settlement. */
  registry?: RegistryClientOptions;
}

/** Where a store keeps the presentations it took, by the digest in their record. */
export interface PresentationStore {
  put(digest: string, presentation: string): Promise<void>;
  all(): Promise<{ [digest: string]: string }>;
}

export class MemoryPresentations implements PresentationStore {
  private readonly map: { [digest: string]: string } = {};
  async put(digest: string, presentation: string): Promise<void> {
    this.map[digest] = presentation;
  }
  async all(): Promise<{ [digest: string]: string }> {
    return { ...this.map };
  }
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
  private readonly presentations: PresentationStore;
  private readonly registry: RegistryClient | undefined;
  private readonly challenges = new Set<string>();
  private taken: Set<string> | undefined;

  constructor(opts: StoreOptions) {
    this.id = opts.id;
    this.privateJwk = opts.privateJwk;
    this.program = opts.program;
    this.programJson = opts.programJson;
    this.recorder = opts.recorder;
    this.now = opts.now ?? (() => new Date());
    this.acceptExpired = opts.acceptExpired ?? false;
    this.presentations = opts.presentations ?? new MemoryPresentations();
    this.registry = opts.registry ? new RegistryClient(opts.registry) : undefined;
  }

  /** The vouchers this store has taken, rebuilt from its records on first use. */
  private async takenSet(): Promise<Set<string>> {
    if (!this.taken) {
      this.taken = new Set();
      for (const r of await this.recorder.records()) {
        if (r.event === 'redeemed' && r.meta?.voucher) this.taken.add(r.meta.voucher);
      }
    }
    return this.taken;
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
   * signature, the holder's signature, the challenge, the expiry, that this
   * store has not taken the voucher before and, with a registry, that no
   * other store has either. Without a registry, that is found at settlement.
   */
  async redeem(presentation: string): Promise<Redemption> {
    const now = this.now();
    const p = await verifyPresentation(this.program, presentation, { aud: this.id, ...(this.acceptExpired ? {} : { at: now }) });
    if (!this.challenges.delete(p.kb.nonce)) throw new VoucherError('nonce', 'unknown or reused challenge');
    const voucherDigest = sha256(p.voucher);
    const taken = await this.takenSet();
    if (taken.has(voucherDigest)) throw new VoucherError('spent', 'already redeemed here');
    // Ask the operator's registry before taking it, so that a voucher spent
    // at another store is refused at the counter.
    if (this.registry) await this.registry.claim(voucherDigest, this.id);
    taken.add(voucherDigest);
    const digest = sha256(presentation);
    const record = await this.recorder.append({
      at: now.toISOString(),
      event: 'redeemed',
      digest,
      meta: { voucher: voucherDigest, issuer: p.claims.iss },
    });
    await this.presentations.put(digest, presentation);
    return { ...p, record, voucherDigest };
  }

  /** The store's claim for settlement. */
  async claim(): Promise<Claim> {
    return { store: this.id, records: await this.recorder.records(), presentations: await this.presentations.all() };
  }
}
