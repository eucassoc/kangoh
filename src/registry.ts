// The operator's registry: the one place a store asks, before it takes a
// voucher, whether another store has taken it already. It holds digests of
// vouchers and the store that took each, nothing about anyone. The store's
// own records and the monthly settlement stay the source of truth; the
// registry is what makes a double use fail at the counter instead of at
// settlement.
//
//   kangoh registry --port 8788 --file claims.jsonl [--token SECRET]
//
//   POST /claim   {"voucher": <digest>, "store": <id>}  → 200 {claimed, store, at}, or 409 when another store has it
//   GET  /spent/<digest>                                 → 200 {spent, store?, at?}
//   GET  /health                                          → 200
import { appendFile, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { VoucherError } from './errors.js';

export interface Claimed {
  voucher: string;
  store: string;
  at: string;
}

/** What a registry answers to a claim. */
export interface ClaimResult {
  /** True when this call recorded the voucher as taken by the store. False when the same store had it already. */
  claimed: boolean;
  store: string;
  at: string;
}

/** The registry's state: claims kept in memory and appended to a file. */
export class Registry {
  private readonly claims = new Map<string, Claimed>();

  constructor(
    readonly file?: string,
    private readonly now: () => Date = () => new Date(),
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

  /** Claims a voucher for a store. Throws a VoucherError('spent') when another store has it. */
  async claim(voucher: string, store: string): Promise<ClaimResult> {
    if (!/^[0-9a-f]{64}$/.test(voucher)) throw new Error('voucher must be a SHA-256 digest');
    if (!store) throw new Error('store is required');
    const prev = this.claims.get(voucher);
    if (prev) {
      if (prev.store !== store) throw new VoucherError('spent', `already redeemed at ${prev.store} at ${prev.at}`);
      return { claimed: false, store: prev.store, at: prev.at };
    }
    const c: Claimed = { voucher, store, at: this.now().toISOString() };
    this.claims.set(voucher, c);
    if (this.file) await appendFile(this.file, JSON.stringify(c) + '\n');
    return { claimed: true, store, at: c.at };
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
  /** Bearer token stores must send; none means open. */
  token?: string;
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
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, claims: opts.registry.size });
      if (!authorized(req, opts.token)) return json(res, 401, { error: 'unauthorized' });
      if (req.method === 'POST' && url.pathname === '/claim') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { voucher?: string; store?: string };
        try {
          return json(res, 200, await opts.registry.claim(String(body.voucher ?? ''), String(body.store ?? '')));
        } catch (e) {
          if (e instanceof VoucherError && e.code === 'spent') {
            const prev = opts.registry.spent(String(body.voucher)) as Claimed;
            return json(res, 409, { error: e.message, store: prev.store, at: prev.at });
          }
          return json(res, 400, { error: (e as Error).message });
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
   */
  async claim(voucher: string, store: string): Promise<ClaimResult | undefined> {
    let res: Response;
    try {
      res = await fetch(new URL('/claim', this.opts.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}) },
        body: JSON.stringify({ voucher, store }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 3000),
      });
    } catch (e) {
      if (this.opts.required) throw new Error(`registry unreachable: ${(e as Error).message}`);
      return undefined;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; store?: string; at?: string; claimed?: boolean };
    if (res.status === 409) throw new VoucherError('spent', body.error ?? `already redeemed at ${body.store}`);
    if (!res.ok) {
      if (this.opts.required) throw new Error(`registry: ${res.status} ${body.error ?? ''}`);
      return undefined;
    }
    return { claimed: Boolean(body.claimed), store: String(body.store), at: String(body.at) };
  }
}
