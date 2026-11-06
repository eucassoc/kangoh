import { decodeJwt, type JWK } from 'jose';
import { present } from './presentation.js';
import type { Redemption } from './store.js';
import { splitVoucher } from './voucher.js';

/** A store's counter, as the wallet sees it. */
export interface Counter {
  id: string;
  challenge(): string;
  redeem(presentation: string): Promise<Redemption>;
}

/**
 * The holder's side: the customer's agent, holding the key vouchers are
 * bound to and the vouchers themselves. Nothing here is known to any store.
 */
export class Wallet {
  readonly vouchers: string[] = [];

  constructor(
    readonly privateJwk: JWK,
    readonly publicJwk: JWK,
  ) {}

  add(voucher: string): void {
    this.vouchers.push(voucher);
  }

  /** Removes and returns the oldest voucher still valid at `now`, dropping expired ones. */
  take(now: Date = new Date()): string | undefined {
    while (this.vouchers.length) {
      const v = this.vouchers.shift() as string;
      if (expiry(v) > now) return v;
    }
    return undefined;
  }

  /** Signs a presentation of a voucher to a store. */
  present(voucher: string, aud: string, nonce: string, now: Date = new Date()): Promise<string> {
    return present(voucher, this.privateJwk, aud, nonce, now);
  }

  /** Presents a voucher at a counter. */
  async redeemAt(counter: Counter, voucher: string, now: Date = new Date()): Promise<Redemption> {
    return counter.redeem(await this.present(voucher, counter.id, counter.challenge(), now));
  }
}

/** The expiry of a voucher, read without verifying it. */
export function expiry(voucher: string): Date {
  const { exp } = decodeJwt(splitVoucher(voucher).jwt);
  return new Date((exp ?? 0) * 1000);
}
