#!/usr/bin/env node
// walife-mcp: the customer's wallet as an MCP server, so that the agent
// that does the shopping holds the vouchers. Tools: receiving_key,
// add_voucher, list_vouchers, present_voucher, remove_voucher.
//
// The wallet is a file (WALIFE_WALLET, default ~/.walife/wallet.json)
// holding the agent's key and its vouchers; no store ever sees it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { decodeJwt } from 'jose';
import { z } from 'zod';
import { sha256 } from './digest.js';
import { parseProgram } from './program.js';
import { present } from './presentation.js';
import { splitVoucher, verifyVoucher, type VoucherClaims } from './voucher.js';
import { openWalletFile, saveWalletFile, walletPath, type WalletFile } from './walletFile.js';

/** What the agent sees of a voucher it holds. */
export type Held = {
  digest: string;
  issuer: string;
  program: string;
  value: number;
  expires: string;
  expired: boolean;
};

export function describe(voucher: string, now: Date = new Date()): Held {
  const c = decodeJwt(splitVoucher(voucher).jwt) as Partial<VoucherClaims>;
  const exp = (c.exp ?? 0) * 1000;
  return {
    digest: sha256(voucher),
    issuer: c.iss ?? '',
    program: c.program ?? '',
    value: c.value ?? 0,
    expires: new Date(exp).toISOString(),
    expired: now.getTime() > exp,
  };
}

const heldSchema = {
  digest: z.string().describe('SHA-256 of the voucher, which names it in other tools'),
  issuer: z.string(),
  program: z.string(),
  value: z.number(),
  expires: z.string(),
  expired: z.boolean(),
};

/** Builds the wallet server over a wallet file. */
export function walletServer(path: string, now: () => Date = () => new Date()): McpServer {
  const server = new McpServer({ name: 'walife', version: '0.1.0' });
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const load = () => openWalletFile(path);
  const find = (w: WalletFile, digest: string) => {
    const i = w.vouchers.findIndex((v) => sha256(v) === digest);
    if (i < 0) throw new Error(`no voucher ${digest} in the wallet`);
    return i;
  };

  server.registerTool(
    'receiving_key',
    {
      title: 'Receiving key',
      description:
        'The public key vouchers are issued to. Give it to a store at checkout so that the store can issue a voucher to this wallet. It identifies nobody; it is only the key a voucher is bound to.',
      outputSchema: { jwk: z.record(z.string(), z.unknown()) },
    },
    async () => {
      const w = await load();
      return { ...text(w.key.publicJwk), structuredContent: { jwk: w.key.publicJwk } };
    },
  );

  server.registerTool(
    'add_voucher',
    {
      title: 'Add a voucher',
      description:
        'Keep a voucher a store issued. If the published program (JSON) is given, the voucher is verified against it first: the issuer must be in the program and the voucher must be bound to this wallet.',
      inputSchema: { voucher: z.string().describe('The voucher as issued'), program: z.string().optional().describe('The published program, as JSON') },
      outputSchema: heldSchema,
    },
    async ({ voucher, program }) => {
      const v = voucher.trim();
      const w = await load();
      if (program) {
        const claims = await verifyVoucher(parseProgram(program), v, { at: now() });
        if (claims.cnf.jwk.x !== w.key.publicJwk.x) throw new Error('the voucher is bound to another key');
      } else {
        splitVoucher(v);
      }
      if (!w.vouchers.some((x) => sha256(x) === sha256(v))) {
        w.vouchers.push(v);
        await saveWalletFile(path, w);
      }
      const h = describe(v, now());
      return { ...text(h), structuredContent: h };
    },
  );

  server.registerTool(
    'list_vouchers',
    {
      title: 'List vouchers',
      description: 'The vouchers this wallet holds, with issuer, value and expiry. Expired vouchers are dropped.',
      outputSchema: { vouchers: z.array(z.object(heldSchema)), total: z.number().describe('Sum of the values of the valid vouchers') },
    },
    async () => {
      const w = await load();
      const held = w.vouchers.map((v) => describe(v, now()));
      if (held.some((h) => h.expired)) {
        w.vouchers = w.vouchers.filter((_, i) => !held[i]?.expired);
        await saveWalletFile(path, w);
      }
      const vouchers = held.filter((h) => !h.expired);
      const out = { vouchers, total: vouchers.reduce((s, h) => s + h.value, 0) };
      return { ...text(out), structuredContent: out };
    },
  );

  server.registerTool(
    'present_voucher',
    {
      title: 'Present a voucher',
      description:
        'Sign a presentation of a voucher to a store, against the challenge the store gave. Hand the result to the store. The voucher stays in the wallet until remove_voucher, once the store has accepted it.',
      inputSchema: {
        store: z.string().describe('The store id the voucher is presented to, as it appears in the program'),
        challenge: z.string().describe('The challenge the store gave for this presentation'),
        digest: z.string().optional().describe('Which voucher; the oldest valid one if omitted'),
      },
      outputSchema: { presentation: z.string(), ...heldSchema },
    },
    async ({ store, challenge, digest }) => {
      const w = await load();
      const valid = w.vouchers.filter((v) => !describe(v, now()).expired);
      const v = digest ? w.vouchers[find(w, digest)] : valid[0];
      if (!v) throw new Error('no valid voucher in the wallet');
      const h = describe(v, now());
      if (h.expired) throw new Error(`voucher ${h.digest} expired at ${h.expires}`);
      const presentation = await present(v, w.key.privateJwk, store, challenge, now());
      const out = { presentation, ...h };
      return { ...text(out), structuredContent: out };
    },
  );

  server.registerTool(
    'remove_voucher',
    {
      title: 'Remove a voucher',
      description: 'Drop a voucher from the wallet after a store accepted it.',
      inputSchema: { digest: z.string() },
      outputSchema: { removed: z.string() },
    },
    async ({ digest }) => {
      const w = await load();
      w.vouchers.splice(find(w, digest), 1);
      await saveWalletFile(path, w);
      return { ...text({ removed: digest }), structuredContent: { removed: digest } };
    },
  );

  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  walletServer(walletPath())
    .connect(new StdioServerTransport())
    .catch((e: Error) => {
      console.error(e.message);
      process.exit(1);
    });
}
