// The operator's service. Two parts, both holding nothing about anyone:
//
// The registry: the one place a store asks, before it takes a voucher,
// whether another store has taken it already. It holds digests of vouchers
// and the store that took each. The store's own records and the monthly
// settlement stay the source of truth; the registry is what makes a double
// use fail at the counter instead of at settlement.
//
// The receipt desk (with --program): where customers' apps claim points
// with receipts and stores answer the claims (desk.ts).
//
//   kangoh registry --port 8788 --file claims.jsonl [--token SECRET]
//                   [--program program.json [--key operator.json]
//                    [--state receipts.jsonl --chain receipts.chain.jsonl]]
//
//   POST /claim   {"voucher": <digest>, "store": <id>, "presentation"?}
//                 → 200 {claimed, store, at, change?}, or 409 when another store has it.
//                 With the presentation of part of a voucher, the registry
//                 (given the operator's key) issues the rest as change.
//   GET  /spent/<digest>                                 → 200 {spent, store?, at?}
//   GET  /change/<digest>                                → 200 {change}: the change issued for a voucher, for a wallet that missed it
//   GET  /health                                          → 200
//
//   POST /receipts              {receipt | token, holder}  → 201 claim, 409 duplicate, 422 refused
//   GET  /receipts/<id>                                     → the claim, with the voucher once issued
//   GET  /receipts?from=DATE    (store token)              → the store's claims
//   POST /receipts/<id>/issue   (store token) {voucher}
//   POST /receipts/<id>/reject  (store token) {reason}
//   GET  /r                                                 → what a phone shows for a receipt QR opened without the app
import { appendFile, readFile } from 'node:fs/promises';
import type { JWK } from 'jose';
import { sha256 } from './digest.js';
import { used, verifyPresentation } from './presentation.js';
import type { Program } from './program.js';
import { issueChange } from './voucher.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { VoucherError } from './errors.js';
import { claimView, DeskError, type ReceiptDesk } from './desk.js';
import { verifyStoreToken } from './receipt.js';

export interface Claimed {
  voucher: string;
  store: string;
  at: string;
  /** The change issued when part of the voucher was used. */
  change?: string;
}

/** What a registry answers to a claim. */
export interface ClaimResult {
  /** True when this call recorded the voucher as taken by the store. False when the same store had it already. */
  claimed: boolean;
  store: string;
  at: string;
  /** The change, when part of the voucher was used. */
  change?: string;
}

/** What the registry needs to issue change: the program and the operator's private key. */
export interface ChangeIssuer {
  program: Program;
  key: JWK;
}

/** The registry's state: claims kept in memory and appended to a file. */
export class Registry {
  private readonly claims = new Map<string, Claimed>();

  constructor(
    readonly file?: string,
    private readonly now: () => Date = () => new Date(),
    private readonly changeIssuer?: ChangeIssuer,
  ) {}

  /** Reloads the claims from the file, if any. */
  async load(): Promise<void> {
    if (!this.file) return;
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const c = JSON.parse(line) as Claimed;
      if (!this.claims.has(c.voucher)) this.claims.set(c.voucher, c);
    }
  }

  /**
   * Claims a voucher for a store. Throws a VoucherError('spent') when
   * another store has it. With the presentation of part of the voucher, the
   * registry verifies it and issues the rest as change to the key the holder
   * named; asked again by the same store, it returns the same change.
   */
  async claim(voucher: string, store: string, presentation?: string): Promise<ClaimResult> {
    if (!/^[0-9a-f]{64}$/.test(voucher)) throw new Error('voucher must be a SHA-256 digest');
    if (!store) throw new Error('store is required');
    const prev = this.claims.get(voucher);
    if (prev) {
      if (prev.store !== store) throw new VoucherError('spent', `already redeemed at ${prev.store} at ${prev.at}`);
      return { claimed: false, store: prev.store, at: prev.at, ...(prev.change ? { change: prev.change } : {}) };
    }
    const now = this.now();
    let change: string | undefined;
    if (presentation) {
      if (!this.changeIssuer) throw new VoucherError('change', 'this registry does not issue change');
      const { program, key } = this.changeIssuer;
      const p = await verifyPresentation(program, presentation, { aud: store, at: now });
      if (sha256(p.voucher) !== voucher) throw new Error('the presentation is not of this voucher');
      const rest = p.claims.value - used(p);
      if (rest > 0) change = await issueChange(program, key, { digest: voucher, claims: p.claims }, p.kb.change?.jwk as JWK, rest, now);
    }
    const c: Claimed = { voucher, store, at: now.toISOString(), ...(change ? { change } : {}) };
    this.claims.set(voucher, c);
    if (this.file) await appendFile(this.file, JSON.stringify(c) + '\n');
    return { claimed: true, store, at: c.at, ...(change ? { change } : {}) };
  }

  spent(voucher: string): Claimed | undefined {
    return this.claims.get(voucher);
  }

  get size(): number {
    return this.claims.size;
  }
}

export interface RegistryServerOptions {
  registry: Registry;
  /** Bearer token stores must send to the registry; none means open. The receipt desk does not use it. */
  token?: string;
  /** The receipt desk, served under /receipts. */
  desk?: ReceiptDesk;
}

function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const got = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The HTTP server over a registry. */
export function registryServer(opts: RegistryServerOptions): Server {
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://registry');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, claims: opts.registry.size, ...(opts.desk ? { receipts: opts.desk.size } : {}) });
      if (opts.desk && (url.pathname === '/receipts' || url.pathname.startsWith('/receipts/') || url.pathname === '/r')) {
        return await deskRoute(opts.desk, req, res, url, json);
      }
      const ch = url.pathname.match(/^\/change\/([0-9a-f]{64})$/);
      if (req.method === 'GET' && ch) {
        // Change is bound to the holder's key, so whoever asks can have it.
        res.setHeader('access-control-allow-origin', '*');
        const c = opts.registry.spent(ch[1] as string);
        return c?.change ? json(res, 200, { change: c.change }) : json(res, 404, { error: 'no change for this voucher' });
      }
      if (!authorized(req, opts.token)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'POST' && url.pathname === '/claim') {
        const body = (await readBody(req)) as { voucher?: string; store?: string; presentation?: string };
        try {
          return json(res, 200, await opts.registry.claim(String(body.voucher ?? ''), String(body.store ?? ''), body.presentation ? String(body.presentation) : undefined));
        } catch (e) {
          if (e instanceof VoucherError && e.code === 'spent') {
            const prev = opts.registry.spent(String(body.voucher)) as Claimed;
            return json(res, 409, { error: e.message, store: prev.store, at: prev.at });
          }
          return json(res, 400, { error: (e as Error).message, ...(e instanceof VoucherError ? { code: e.code } : {}) });
        }
      }
      const m = url.pathname.match(/^\/spent\/([0-9a-f]{64})$/);
      if (req.method === 'GET' && m) {
        const c = opts.registry.spent(m[1] as string);
        return json(res, 200, c ? { spent: true, store: c.store, at: c.at } : { spent: false });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new DeskError(413, 'request too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const QR_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>kangoh</title>
<p>このQRコードはレシートのポイントを受け取るためのものです。ポイントのアプリで読み取ってください。</p>
<p>This QR code claims the points for a receipt. Scan it with your points app.</p>`;

async function deskRoute(
  desk: ReceiptDesk,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  json: (res: ServerResponse, status: number, body: unknown) => void,
): Promise<void> {
  // Customers' apps call the open endpoints from anywhere.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  try {
    if (url.pathname === '/r') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(QR_PAGE);
      return;
    }
    const store = async (): Promise<string> => {
      const auth = req.headers.authorization ?? '';
      const m = auth.match(/^Store\s+(\S+)$/);
      if (!m) throw new DeskError(401, 'a store token is required: Authorization: Store <token>');
      try {
        return await verifyStoreToken(desk.opts.program, m[1] as string, desk.opts.now?.() ?? new Date());
      } catch (e) {
        throw new DeskError(401, (e as Error).message);
      }
    };
    if (url.pathname === '/receipts') {
      if (req.method === 'POST') {
        const body = (await readBody(req)) as Parameters<ReceiptDesk['submit']>[0];
        const c = await desk.submit(body);
        return json(res, c.status === 'duplicate' ? 409 : 201, claimView(c));
      }
      if (req.method === 'GET') {
        const id = await store();
        const from = url.searchParams.get('from') ?? undefined;
        return json(res, 200, { store: id, claims: desk.list(id, from) });
      }
    }
    const m = url.pathname.match(/^\/receipts\/([0-9a-f]{32})(\/issue|\/reject)?$/);
    if (m) {
      const id = m[1] as string;
      if (req.method === 'GET' && !m[2]) {
        const c = desk.get(id);
        return c ? json(res, 200, claimView(c)) : json(res, 404, { error: 'no such claim' });
      }
      if (req.method === 'POST' && m[2] === '/issue') {
        const s = await store();
        const body = (await readBody(req)) as { voucher?: string };
        return json(res, 200, claimView(await desk.issue(s, id, String(body.voucher ?? '').trim())));
      }
      if (req.method === 'POST' && m[2] === '/reject') {
        const s = await store();
        const body = (await readBody(req)) as { reason?: string };
        return json(res, 200, claimView(await desk.reject(s, id, String(body.reason ?? ''))));
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof DeskError) return json(res, e.status, { error: e.message });
    if (e instanceof SyntaxError) return json(res, 400, { error: 'the body is not JSON' });
    throw e;
  }
}

/** How a store reaches the registry. */
export interface RegistryClientOptions {
  url: string;
  token?: string;
  /**
   * When the registry cannot be reached: refuse the voucher (true), or take
   * it and leave a double use to settlement (false, the default).
   */
  required?: boolean;
  /** Milliseconds to wait for the registry. */
  timeoutMs?: number;
}

/** The store side of the registry. */
export class RegistryClient {
  constructor(readonly opts: RegistryClientOptions) {}

  /**
   * Claims a voucher for the store. Resolves to the registry's answer, or to
   * undefined when the registry could not be reached and is not required.
   * Rejects with VoucherError('spent') when another store has the voucher.
   * With a presentation (part of the voucher used), the registry must answer
   * with the change, or the claim fails: without change the customer would
   * lose the rest.
   */
  async claim(voucher: string, store: string, presentation?: string): Promise<ClaimResult | undefined> {
    const required = this.opts.required || presentation !== undefined;
    let res: Response;
    try {
      res = await fetch(new URL('/claim', this.opts.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}) },
        body: JSON.stringify({ voucher, store, ...(presentation ? { presentation } : {}) }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
    } catch (e) {
      if (presentation) throw new VoucherError('change', `the registry cannot be reached, so no change can be issued; use the whole voucher (${(e as Error).message})`);
      if (required) throw new Error(`registry unreachable: ${(e as Error).message}`);
      return undefined;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string; store?: string; at?: string; claimed?: boolean; change?: string };
    if (res.status === 409) throw new VoucherError('spent', body.error ?? `already redeemed at ${body.store}`);
    if (!res.ok) {
      if (presentation) throw new VoucherError('change', `the registry issued no change: ${body.error ?? res.status}`);
      if (required) throw new Error(`registry: ${res.status} ${body.error ?? ''}`);
      return undefined;
    }
    return { claimed: Boolean(body.claimed), store: String(body.store), at: String(body.at), ...(body.change ? { change: body.change } : {}) };
  }
}
