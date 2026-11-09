// The two sides of the receipt desk, over HTTP: the customer's app claims a
// receipt and collects the voucher; the store reads the day's claims,
// approves them with its key or refuses them, and issues the ones made with
// its signed QR without review.
import type { JWK } from 'jose';
import { DeskError, type ClaimStatus, type ReceiptClaim } from './desk.js';
import { earned } from './program.js';
import type { Receipt } from './receipt.js';
import type { Store } from './store.js';

/** A claim as the customer's app sees it. */
export type ClaimView = Omit<ReceiptClaim, 'holder' | 'duplicateOf'>;

export class DeskClient {
  readonly service: string;

  constructor(
    service: string,
    readonly opts: { timeoutMs?: number } = {},
  ) {
    this.service = service.replace(/\/$/, '');
  }

  /** Claims a receipt for a key. A duplicate is not an error: it comes back with status `duplicate` and the reason. */
  async submit(body: { receipt?: Receipt; token?: string; holder: JWK }): Promise<ClaimView> {
    return this.call('POST', '/receipts', undefined, body, [201, 409]);
  }

  /** The state of a claim, with the voucher once the store has issued it. */
  async status(id: string): Promise<ClaimView> {
    return this.call('GET', `/receipts/${id}`);
  }

  /** The store's claims submitted on or after `from` (YYYY-MM-DD). */
  async list(token: string, from?: string): Promise<ReceiptClaim[]> {
    const r = await this.call<{ claims: ReceiptClaim[] }>('GET', `/receipts${from ? `?from=${encodeURIComponent(from)}` : ''}`, token);
    return r.claims;
  }

  async issue(token: string, id: string, voucher: string): Promise<ClaimView> {
    return this.call('POST', `/receipts/${id}/issue`, token, { voucher });
  }

  async reject(token: string, id: string, reason: string): Promise<ClaimView> {
    return this.call('POST', `/receipts/${id}/reject`, token, { reason });
  }

  private async call<T>(method: string, path: string, token?: string, body?: unknown, ok: number[] = [200]): Promise<T> {
    const res = await fetch(this.service + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Store ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    const out = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!ok.includes(res.status)) throw new DeskError(res.status, out.error ?? `${method} ${path}: ${res.status}`);
    return out;
  }
}

/** The outcome of answering one claim. */
export interface Answered {
  id: string;
  status: ClaimStatus;
  value?: number;
  reason?: string;
  error?: string;
}

/** The store's claims, in the order its review screen shows them: refused duplicates first, then those waiting. */
export async function storeClaims(store: Store, client: DeskClient, from?: string): Promise<ReceiptClaim[]> {
  const order: { [s in ClaimStatus]: number } = { duplicate: 0, pending: 1, authorized: 2, rejected: 3, issued: 4 };
  const list = await client.list(await store.serviceToken(), from);
  return list.sort((a, b) => order[a.status] - order[b.status] || a.receipt.at.localeCompare(b.receipt.at) || a.submitted.localeCompare(b.submitted));
}

/**
 * Approves claims: signs a voucher to each claim's key with the store's key,
 * records the issuance and hands the voucher to the desk. `ids` picks claims,
 * all waiting ones when omitted. `totals` corrects a total the customer's
 * app misread; the points follow the corrected total.
 */
export async function approveReceipts(store: Store, client: DeskClient, opts: { ids?: string[]; totals?: { [id: string]: number }; from?: string } = {}): Promise<Answered[]> {
  const token = await store.serviceToken();
  const waiting = (await client.list(token, opts.from)).filter((c) => c.status === 'pending' || c.status === 'authorized');
  const chosen = opts.ids ? waiting.filter((c) => opts.ids?.includes(c.id)) : waiting;
  const out: Answered[] = [];
  for (const id of opts.ids ?? []) if (!waiting.some((c) => c.id === id)) out.push({ id, status: 'pending', error: 'not waiting for this store' });
  for (const c of chosen) {
    const total = opts.totals?.[c.id];
    const value = total !== undefined ? earned(store.programOf, total) : c.value;
    if (!c.holder || value <= 0) {
      out.push({ id: c.id, status: c.status, error: value <= 0 ? `a total of ${total} earns no points` : 'the claim has no key' });
      continue;
    }
    try {
      const voucher = await store.issue(c.holder, { value, meta: { claim: c.id } });
      const r = await client.issue(token, c.id, voucher);
      out.push({ id: c.id, status: r.status, value: r.value });
    } catch (e) {
      out.push({ id: c.id, status: c.status, error: (e as Error).message });
    }
  }
  return out;
}

/** Issues every claim made with the store's signed receipt QR. Nothing to review: the QR was the approval. */
export async function syncReceipts(store: Store, client: DeskClient, from?: string): Promise<Answered[]> {
  const token = await store.serviceToken();
  const signed = (await client.list(token, from)).filter((c) => c.status === 'authorized').map((c) => c.id);
  if (!signed.length) return [];
  return approveReceipts(store, client, { ids: signed, ...(from ? { from } : {}) });
}

/** Refuses a claim, with the reason the customer will see. */
export async function rejectReceipt(store: Store, client: DeskClient, id: string, reason: string): Promise<Answered> {
  const r = await client.reject(await store.serviceToken(), id, reason);
  return { id, status: r.status, ...(r.reason ? { reason: r.reason } : {}) };
}
