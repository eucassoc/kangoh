#!/usr/bin/env node
// kangoh-mcp: the three roles of a program as MCP servers, one per process.
//
//   kangoh-mcp            the customer's wallet (KANGOH_WALLET, default
//                         ~/.kangoh/wallet.json): the agent that does the
//                         shopping holds the vouchers and claims receipts
//   kangoh-mcp store      a store (KANGOH_STORE, its directory): issuing,
//                         redeeming, the day's receipt claims and the claim
//                         for settlement
//   kangoh-mcp operator   the program operator: settlement from the
//                         stores' claims
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { isMain } from './main.js';
import { decodeJwt, type JWK } from 'jose';
import { z } from 'zod';
import { sha256 } from './digest.js';
import { parseProgram } from './program.js';
import { present } from './presentation.js';
import { formatFinding, settle } from './settlement.js';
import type { Claim } from './store.js';
import { openStore, storeDir } from './storeDir.js';
import { splitVoucher, verifyVoucher, type VoucherClaims } from './voucher.js';
import { keyFor, openWalletFile, saveWalletFile, walletPath, type WalletFile } from './walletFile.js';
import { generateKey } from './keys.js';
import { VERSION } from './version.js';
import { parseReceiptQr, type Receipt } from './receipt.js';
import { approveReceipts, DeskClient, rejectReceipt, storeClaims, syncReceipts } from './deskClient.js';

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
  const server = new McpServer({ name: 'kangoh', version: VERSION });
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
        'Keep a voucher a store issued, or the change a store handed back after part of a voucher was used. If the published program (JSON) is given, the voucher is verified against it first: the issuer must be in the program and the voucher must be bound to a key of this wallet.',
      inputSchema: { voucher: z.string().describe('The voucher as issued'), program: z.string().optional().describe('The published program, as JSON') },
      outputSchema: heldSchema,
    },
    async ({ voucher, program }) => {
      const v = voucher.trim();
      const w = await load();
      if (program) {
        const claims = await verifyVoucher(parseProgram(program), v, { at: now() });
        if (!keyFor(w, claims.cnf.jwk.x)) throw new Error('the voucher is bound to a key this wallet does not hold');
      } else {
        splitVoucher(v);
      }
      if (!w.vouchers.some((x) => sha256(x) === sha256(v))) {
        w.vouchers.push(v);
        const parent = (decodeJwt(splitVoucher(v).jwt) as Partial<VoucherClaims>).chg?.parent;
        if (parent) w.changes = (w.changes ?? []).filter((c) => c.parent !== parent);
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
        'Sign a presentation of a voucher to a store, against the challenge the store gave. Hand the result to the store. With amount, only that many points are used: the store takes the voucher and hands back the rest as change, issued by the program operator to a fresh key of this wallet; keep it with add_voucher. The voucher stays in the wallet until remove_voucher, once the store has accepted it.',
      inputSchema: {
        store: z.string().describe('The store id the voucher is presented to, as it appears in the program'),
        challenge: z.string().describe('The challenge the store gave for this presentation'),
        digest: z.string().optional().describe('Which voucher; if omitted, the oldest valid one worth at least amount'),
        amount: z.number().int().positive().optional().describe('Points to use, when less than the whole voucher'),
        program: z.string().optional().describe("The published program (JSON), so that change the store does not hand back can be fetched from the operator's service"),
      },
      outputSchema: { presentation: z.string(), used: z.number(), ...heldSchema },
    },
    async ({ store, challenge, digest, amount, program }) => {
      const w = await load();
      const valid = w.vouchers.filter((v) => !describe(v, now()).expired);
      const v = digest ? w.vouchers[find(w, digest)] : valid.find((x) => amount === undefined || describe(x).value >= amount);
      if (!v) throw new Error(amount !== undefined && valid.length ? `no single voucher is worth ${amount}; present several` : 'no valid voucher in the wallet');
      const h = describe(v, now());
      if (h.expired) throw new Error(`voucher ${h.digest} expired at ${h.expires}`);
      if (amount !== undefined && amount > h.value) throw new Error(`voucher ${h.digest} is worth ${h.value}, less than ${amount}`);
      const key = keyFor(w, (decodeJwt(splitVoucher(v).jwt) as Partial<VoucherClaims>).cnf?.jwk?.x);
      if (!key) throw new Error(`voucher ${h.digest} is bound to a key this wallet does not hold`);
      let partial;
      if (amount !== undefined && amount < h.value) {
        const changeKey = await generateKey();
        partial = { amount, change: changeKey.publicJwk };
        const service = program ? parseProgram(program).service : undefined;
        w.keys = [...(w.keys ?? []), changeKey];
        w.changes = [...(w.changes ?? []).filter((c) => c.parent !== h.digest), { parent: h.digest, kid: changeKey.kid, ...(service ? { service } : {}) }];
        await saveWalletFile(path, w);
      }
      const presentation = await present(v, key.privateJwk, store, challenge, now(), partial);
      const out = { presentation, used: amount ?? h.value, ...h };
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
      const [v] = w.vouchers.splice(find(w, digest), 1);
      const x = (decodeJwt(splitVoucher(v as string).jwt) as Partial<VoucherClaims>).cnf?.jwk?.x;
      const inUse = (k: { publicJwk: JWK }) => w.vouchers.some((u) => (decodeJwt(splitVoucher(u).jwt) as Partial<VoucherClaims>).cnf?.jwk?.x === k.publicJwk.x);
      if (w.keys) w.keys = w.keys.filter((k) => k.publicJwk.x !== x || inUse(k) || [...(w.pending ?? []), ...(w.changes ?? [])].some((p) => p.kid === k.kid));
      await saveWalletFile(path, w);
      return { ...text({ removed: digest }), structuredContent: { removed: digest } };
    },
  );

  server.registerTool(
    'claim_receipt',
    {
      title: 'Claim points with a receipt',
      description:
        "Claim the points for a purchase with its receipt. Give the receipt's QR code if it has one (the store's signed approval; points arrive without review), or the store, time, number and total as printed, with the program (JSON), whose operator's service takes the claim; the store confirms printed receipts against its sales once a day. The claim is bound to a fresh key, so claims cannot be linked to each other. A receipt is claimed once: if someone claimed it first, the claim is refused as a duplicate, and the customer should take the receipt to the store. Then call check_claims later to collect the points.",
      inputSchema: {
        qr: z.string().optional().describe('The text of the QR code printed on the receipt'),
        program: z.string().optional().describe('The published program, as JSON; required for a printed receipt, and for a QR that is not a link'),
        store: z.string().optional().describe('The store id in the program'),
        at: z.string().optional().describe('Time of purchase as printed, YYYY-MM-DDTHH:MM'),
        number: z.string().optional().describe('Receipt number as printed, with the register if numbers are per register'),
        total: z.number().optional().describe('Total paid, in yen'),
      },
      outputSchema: { id: z.string(), status: z.string(), store: z.string(), value: z.number(), reason: z.string().optional() },
    },
    async ({ qr, program, store, at, number, total }) => {
      const p = program ? parseProgram(program) : undefined;
      let service = p?.service;
      let body: { token?: string; receipt?: Receipt };
      if (qr) {
        const parsed = parseReceiptQr(qr);
        service = parsed.service ?? service;
        body = { token: parsed.token };
      } else {
        if (!store || !at || !number || total === undefined) throw new Error('give the QR, or the store, at, number and total');
        body = { receipt: { store, at, number, total } };
      }
      if (!service) throw new Error("no service: give the program, which names the operator's service");
      const w = await load();
      const key = await generateKey();
      const c = await new DeskClient(service).submit({ ...body, holder: key.publicJwk });
      if (c.status !== 'duplicate') {
        w.keys = [...(w.keys ?? []), key];
        w.pending = [...(w.pending ?? []), { id: c.id, service, store: c.store, receipt: { at: c.receipt.at, number: c.receipt.number, total: c.receipt.total }, value: c.value, submitted: c.submitted, kid: key.kid }];
        await saveWalletFile(path, w);
      }
      const out = { id: c.id, status: c.status, store: c.store, value: c.value, ...(c.reason ? { reason: c.reason } : {}) };
      return { ...text(out), structuredContent: out };
    },
  );

  server.registerTool(
    'check_claims',
    {
      title: 'Check receipt claims',
      description:
        'Ask the operator\'s service about the receipt claims this wallet is waiting on, and keep the points the stores have issued. A refused claim is dropped with the store\'s reason; the customer can take the receipt to the store. Change due from a voucher used in part, that the store did not hand back, is fetched too.',
      outputSchema: {
        claims: z.array(z.object({ id: z.string(), store: z.string(), status: z.string(), value: z.number(), reason: z.string().optional() })),
      },
    },
    async () => {
      const w = await load();
      const out: { id: string; store: string; status: string; value: number; reason?: string }[] = [];
      const still = [];
      for (const p of w.pending ?? []) {
        let c;
        try {
          c = await new DeskClient(p.service).status(p.id);
        } catch (e) {
          out.push({ id: p.id, store: p.store, status: 'unreachable', value: p.value, reason: (e as Error).message });
          still.push(p);
          continue;
        }
        if (c.status === 'issued' && c.voucher) {
          const x = (decodeJwt(splitVoucher(c.voucher).jwt) as Partial<VoucherClaims>).cnf?.jwk?.x;
          const k = (w.keys ?? []).find((k) => k.kid === p.kid);
          if (!k || k.publicJwk.x !== x) {
            out.push({ id: p.id, store: p.store, status: 'refused', value: c.value, reason: 'the voucher is bound to another key' });
            continue;
          }
          if (!w.vouchers.some((v) => v === c.voucher)) w.vouchers.push(c.voucher);
          out.push({ id: p.id, store: p.store, status: 'issued', value: c.value });
        } else if (c.status === 'rejected' || c.status === 'duplicate') {
          w.keys = (w.keys ?? []).filter((k) => k.kid !== p.kid);
          out.push({ id: p.id, store: p.store, status: c.status, value: c.value, ...(c.reason ? { reason: c.reason } : {}) });
        } else {
          out.push({ id: p.id, store: p.store, status: c.status, value: c.value });
          still.push(p);
        }
      }
      w.pending = still;
      // Change the store did not hand back, fetched from the operator's registry.
      for (const ch of [...(w.changes ?? [])]) {
        if (!ch.service) continue;
        const res = await fetch(`${ch.service.replace(/\/$/, '')}/change/${ch.parent}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
        if (!res?.ok) continue;
        const { change } = (await res.json()) as { change?: string };
        const k = (w.keys ?? []).find((k) => k.kid === ch.kid);
        if (!change || !k || (decodeJwt(splitVoucher(change).jwt) as Partial<VoucherClaims>).cnf?.jwk?.x !== k.publicJwk.x) continue;
        if (!w.vouchers.includes(change)) w.vouchers.push(change);
        w.changes = (w.changes ?? []).filter((c) => c !== ch);
        const h = describe(change, now());
        out.push({ id: ch.parent, store: h.issuer, status: 'change', value: h.value });
      }
      await saveWalletFile(path, w);
      return { ...text({ claims: out }), structuredContent: { claims: out } };
    },
  );

  return server;
}

const jwkSchema = z.record(z.string(), z.unknown());

/** Builds the store server over a store directory. */
export function storeServer(dir: string, now: () => Date = () => new Date()): McpServer {
  const server = new McpServer({ name: 'kangoh-store', version: VERSION });
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const store = openStore(dir, now);

  server.registerTool(
    'issue_voucher',
    {
      title: 'Issue a voucher',
      description:
        "Issue a voucher to a customer's receiving key at the counter: of the program's value, or of `value` points in a program that earns points from receipts, for example for a customer whose receipt claim was refused as a duplicate but who brought the receipt. The voucher is returned to hand to the customer; only its digest is recorded.",
      inputSchema: {
        holder: jwkSchema.describe("The customer's receiving key (a public JWK)"),
        value: z.number().int().positive().optional().describe('Points, when the program earns points from receipts'),
        claim: z.string().optional().describe('The refused receipt claim this settles, recorded with the issuance'),
      },
      outputSchema: { voucher: z.string(), ...heldSchema },
    },
    async ({ holder, value, claim }) => {
      const voucher = await (await store).issue(holder as JWK, { ...(value !== undefined ? { value } : {}), ...(claim ? { meta: { settles: claim } } : {}) });
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
        "Accept a presentation a customer handed over for one of this store's challenges. The issuer's and the holder's signatures, the challenge and the expiry are checked against the program; the presentation is recorded and kept as the claim on the issuer. Give the customer a discount of `amount` only when this succeeds. When the customer used part of the voucher, the operator's registry issues the rest as `change`: hand it back to the customer.",
      inputSchema: { presentation: z.string() },
      outputSchema: {
        issuer: z.string(),
        value: z.number().describe("The voucher's value"),
        amount: z.number().describe('Points taken: the discount to give'),
        change: z.string().optional().describe('When part of the voucher was used: the rest, issued by the operator, to hand back to the customer'),
        voucher: z.string().describe('Digest of the voucher'),
        record: z.number().describe("Sequence number of this store's record"),
      },
    },
    async ({ presentation }) => {
      const r = await (await store).redeem(presentation.trim());
      const out = { issuer: r.claims.iss, value: r.claims.value, amount: r.amount, ...(r.change ? { change: r.change } : {}), voucher: r.voucherDigest, record: r.record.seq };
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

  const desk = async () => {
    const s = await store;
    const service = s.programOf.service;
    if (!service) throw new Error("the program names no service: receipt claims need the operator's service");
    return { s, client: new DeskClient(service) };
  };
  const claimSchema = z.object({
    id: z.string(),
    status: z.string(),
    receipt: z.object({ at: z.string(), number: z.string(), total: z.number() }),
    value: z.number(),
    signed: z.boolean(),
    reason: z.string().optional(),
  });

  server.registerTool(
    'receipts',
    {
      title: "The day's receipt claims",
      description:
        "Receipt claims customers made for this store: refused duplicates first (the receipt was claimed before; shown as errors, nothing to do unless the customer comes to the counter with the receipt), then those waiting for review. Compare each waiting one with the store's sales for that time, number and total, then approve_receipts or reject_receipt. Claims made with the store's signed QR need no review; sync_receipts issues them.",
      inputSchema: { from: z.string().optional().describe('Claims submitted on or after this date, YYYY-MM-DD; all when omitted') },
      outputSchema: { claims: z.array(claimSchema) },
    },
    async ({ from }) => {
      const { s, client } = await desk();
      const claims = (await storeClaims(s, client, from)).map((c) => ({
        id: c.id,
        status: c.status,
        receipt: { at: c.receipt.at, number: c.receipt.number, total: c.receipt.total },
        value: c.value,
        signed: c.signed,
        ...(c.reason ? { reason: c.reason } : {}),
      }));
      return { ...text({ claims }), structuredContent: { claims } };
    },
  );

  const answered = { results: z.array(z.object({ id: z.string(), status: z.string(), value: z.number().optional(), reason: z.string().optional(), error: z.string().optional() })) };

  server.registerTool(
    'approve_receipts',
    {
      title: 'Approve receipt claims',
      description:
        "Approve claims after checking them against the store's sales: a voucher for each is signed with the store's key, recorded, and handed to the customer through the operator's service. Without ids, every waiting claim is approved. To correct a total the customer's app misread, give it in totals; the points follow it.",
      inputSchema: {
        ids: z.array(z.string()).optional(),
        totals: z.record(z.string(), z.number()).optional().describe('Corrected totals by claim id'),
      },
      outputSchema: answered,
    },
    async ({ ids, totals }) => {
      const { s, client } = await desk();
      const results = await approveReceipts(s, client, { ...(ids ? { ids } : {}), ...(totals ? { totals } : {}) });
      return { ...text({ results }), structuredContent: { results } };
    },
  );

  server.registerTool(
    'reject_receipt',
    {
      title: 'Reject a receipt claim',
      description: 'Refuse a claim that does not match the sales, with a reason the customer sees (for example: no such receipt number, or the total differs).',
      inputSchema: { id: z.string(), reason: z.string() },
      outputSchema: answered,
    },
    async ({ id, reason }) => {
      const { s, client } = await desk();
      const results = [await rejectReceipt(s, client, id, reason)];
      return { ...text({ results }), structuredContent: { results } };
    },
  );

  server.registerTool(
    'sync_receipts',
    {
      title: 'Issue signed-QR claims',
      description: "Issue every claim made with the store's signed receipt QR. No review: the QR was the store's approval when it was printed. Run it as often as convenient.",
      outputSchema: answered,
    },
    async () => {
      const { s, client } = await desk();
      const results = await syncReceipts(s, client);
      return { ...text({ results }), structuredContent: { results } };
    },
  );

  return server;
}

/** Builds the operator server, which keeps no state. */
export function operatorServer(): McpServer {
  const server = new McpServer({ name: 'kangoh-operator', version: VERSION });
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

if (isMain(import.meta.url)) {
  try {
    await serverFor(process.argv[2]).connect(new StdioServerTransport());
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
