#!/usr/bin/env node
// walife-mcp: the three roles of a program as MCP servers, one per process.
//
//   walife-mcp            the customer's wallet (WALIFE_WALLET, default
//                         ~/.walife/wallet.json): the agent that does the
//                         shopping holds the vouchers
//   walife-mcp store      a store (WALIFE_STORE, its directory): issuing,
//                         redeeming and the claim for settlement
//   walife-mcp operator   the program operator: settlement from the
//                         stores' claims
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { decodeJwt, type JWK } from 'jose';
import { z } from 'zod';
import { sha256 } from './digest.js';
import { parseProgram } from './program.js';
import { present } from './presentation.js';
import { formatFinding, settle } from './settlement.js';
import type { Claim } from './store.js';
import { openStore, storeDir } from './storeDir.js';
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

const jwkSchema = z.record(z.string(), z.unknown());

/** Builds the store server over a store directory. */
export function storeServer(dir: string, now: () => Date = () => new Date()): McpServer {
  const server = new McpServer({ name: 'walife-store', version: '0.1.0' });
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const store = openStore(dir, now);

  server.registerTool(
    'issue_voucher',
    {
      title: 'Issue a voucher',
      description:
        "Issue one voucher of the program's value to a customer's receiving key, after a purchase. The voucher is returned to hand to the customer; only its digest is recorded.",
      inputSchema: { holder: jwkSchema.describe("The customer's receiving key (a public JWK)") },
      outputSchema: { voucher: z.string(), ...heldSchema },
    },
    async ({ holder }) => {
      const voucher = await (await store).issue(holder as JWK);
      const out = { voucher, ...describe(voucher, now()) };
      return { ...text(out), structuredContent: out };
    },
  );

  server.registerTool(
    'challenge',
    {
      title: 'Challenge',
      description: 'A fresh challenge to give a customer who wants to present a voucher. Each challenge accepts one presentation.',
      outputSchema: { store: z.string(), challenge: z.string() },
    },
    async () => {
      const s = await store;
      const out = { store: s.id, challenge: s.challenge() };
      return { ...text(out), structuredContent: out };
    },
  );

  server.registerTool(
    'redeem_voucher',
    {
      title: 'Redeem a voucher',
      description:
        "Accept a presentation a customer handed over for one of this store's challenges. The issuer's and the holder's signatures, the challenge and the expiry are checked against the program; the presentation is recorded and kept as the claim on the issuer. Give the customer the discount only when this succeeds.",
      inputSchema: { presentation: z.string() },
      outputSchema: { issuer: z.string(), value: z.number(), voucher: z.string().describe('Digest of the voucher'), record: z.number().describe("Sequence number of this store's record") },
    },
    async ({ presentation }) => {
      const r = await (await store).redeem(presentation.trim());
      const out = { issuer: r.claims.iss, value: r.claims.value, voucher: r.voucherDigest, record: r.record.seq };
      return { ...text(out), structuredContent: out };
    },
  );

  server.registerTool(
    'claim',
    {
      title: 'Claim for settlement',
      description: "This store's claim for the settlement period: its records and the presentations it took, to send to the program operator.",
      outputSchema: { store: z.string(), records: z.array(z.record(z.string(), z.unknown())), presentations: z.record(z.string(), z.string()) },
    },
    async () => {
      const c = await (await store).claim();
      return { ...text(c), structuredContent: { ...c } };
    },
  );

  return server;
}

/** Builds the operator server, which keeps no state. */
export function operatorServer(): McpServer {
  const server = new McpServer({ name: 'walife-operator', version: '0.1.0' });
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const document = async (s: string) => (s.trimStart().startsWith('{') ? s : readFile(s, 'utf8'));

  server.registerTool(
    'settle',
    {
      title: 'Settle',
      description:
        "Settle a period from the stores' claims. Each voucher is paid once, to the first store that recorded it, in time order across all stores; every redemption that is not paid is a finding tied to the store's record. The program and each claim are given as JSON or as a path to a file.",
      inputSchema: {
        program: z.string().describe('The published program, as JSON or a file path'),
        claims: z.array(z.string()).describe("The stores' claims, each as JSON or a file path"),
      },
      outputSchema: {
        findings: z.array(z.object({ store: z.string(), seq: z.number(), at: z.string(), problem: z.string() })),
        statements: z.array(z.object({ store: z.string(), issued: z.number(), accepted: z.number(), own: z.number(), receives: z.number(), pays: z.number() })),
      },
    },
    async ({ program, claims }) => {
      const programJson = await document(program);
      const parsed: Claim[] = [];
      for (const c of claims) parsed.push(JSON.parse(await document(c)) as Claim);
      const out = await settle(parseProgram(programJson), programJson, parsed);
      const lines = [...out.findings.map(formatFinding), JSON.stringify(out.statements, null, 2)];
      return { ...text(lines.join('\n')), structuredContent: { ...out } };
    },
  );

  return server;
}

/** The server for a role argument: wallet (default), store or operator. */
export function serverFor(role: string | undefined, env: NodeJS.ProcessEnv = process.env): McpServer {
  switch (role ?? 'wallet') {
    case 'wallet':
      return walletServer(walletPath(env));
    case 'store':
      return storeServer(storeDir(env));
    case 'operator':
      return operatorServer();
    default:
      throw new Error(`unknown role ${role}; use wallet, store or operator`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    await serverFor(process.argv[2]).connect(new StdioServerTransport());
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
