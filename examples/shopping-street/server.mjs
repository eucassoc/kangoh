// A fictional shopping street of three shops on kangoh. The customer's app
// claims points from a receipt; the bakery reviews the day's claims once and
// signs; the café's QR is already signed; a gift shop takes points with change
// from the operator; a copied app is refused at the counter; the operator
// settles between the shops. All real kangoh: keys, vouchers, presentations,
// the receipt desk, the registry and the settlement. Only the app runs here,
// in the server, to keep the demo to one process; in practice it runs on the
// customer's phone and its keys never leave it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  generateKey, parseProgram, Store, MemoryRecorder, Wallet, ReceiptDesk, Registry, registryServer, DeskClient,
  storeClaims, approveReceipts, syncReceipts, receiptQr, parseReceiptQr, verifyVoucher, settle,
} from 'kangoh';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8900);
const SERVICE_PORT = Number(process.env.SERVICE_PORT ?? 8901);

const SHOPS = {
  komugi: { id: 'komugi.hidamari.example', name: 'パン工房こむぎ', receipts: 'review' },
  kissa: { id: 'kissa.hidamari.example', name: '喫茶ひだまり', receipts: 'signed' },
  tsumugi: { id: 'tsumugi.hidamari.example', name: '雑貨つむぎ', receipts: 'review' },
};
const OPERATOR = { id: 'operator.hidamari.example', name: 'ひだまり商店街（運営）' };
const nameOf = (id) => Object.values(SHOPS).find((s) => s.id === id)?.name ?? (id === OPERATOR.id ? OPERATOR.name : id);

// The receipt the customer brings: yesterday's, from the bakery.
const day = (d) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
const RECEIPT = () => ({ store: SHOPS.komugi.id, at: `${day(1)}T17:42`, number: 'R01-0042', total: 1850, lines: [['クロワッサン', 2, 260], ['カンパーニュ', 1, 580], ['あんぱん', 3, 250]] });

let S;
let service;

async function setup() {
  if (service) await new Promise((r) => service.close(r));
  const keys = {};
  for (const k of Object.keys(SHOPS)) keys[k] = await generateKey();
  const operator = await generateKey();
  const url = `http://127.0.0.1:${SERVICE_PORT}`;
  const program = {
    name: 'hidamari.example',
    earn: { per: 100, points: 1, max: 500 },
    validDays: 180,
    receiptDays: 7,
    qrMinutes: 10,
    service: url,
    operator: { id: OPERATOR.id, key: operator.publicJwk },
    stores: Object.entries(SHOPS).map(([k, s]) => ({ id: s.id, key: keys[k].publicJwk, ...(s.receipts === 'signed' ? { receipts: 'signed' } : {}) })),
  };
  const programJson = JSON.stringify(program);
  const parsed = parseProgram(programJson);
  // The operator's service: the receipt desk and the registry, which also issues change.
  const desk = new ReceiptDesk({ program: parsed, secret: 'demo-desk-secret' });
  await desk.load();
  const registry = new Registry({ program: parsed, changeKey: operator.privateJwk });
  service = registryServer({ registry, desk });
  await new Promise((r) => service.listen(SERVICE_PORT, '127.0.0.1', r));
  const stores = {};
  for (const [k, s] of Object.entries(SHOPS)) {
    stores[k] = new Store({ id: s.id, privateJwk: keys[k].privateJwk, program: parsed, programJson, recorder: new MemoryRecorder(), registry: { url } });
    await stores[k].join();
  }
  S = { program: parsed, programJson, stores, client: new DeskClient(url), held: [], pending: [], spent: [], log: [], qr: null };
}

// The app: a fresh key per claim; a voucher is kept with the key it is bound to.
async function keep(voucher, key, note) {
  const c = await verifyVoucher(S.program, voucher);
  S.held.push({ voucher, key, value: c.value, issuer: c.iss, exp: c.exp, note, change: Boolean(c.chg) });
}
async function collect() {
  const got = [];
  for (const p of [...S.pending]) {
    const v = await S.client.status(p.id);
    p.status = v.status; p.reason = v.reason;
    if (v.status === 'issued' && v.voucher) {
      await keep(v.voucher, p.key, p.note);
      S.pending = S.pending.filter((x) => x !== p);
      got.push({ store: p.store, value: v.value });
    }
  }
  return got;
}
const view = () => ({
  balance: S.held.reduce((n, h) => n + h.value, 0),
  held: S.held.map((h) => ({ value: h.value, from: nameOf(h.issuer), exp: new Date(h.exp * 1000).toISOString().slice(0, 10), change: h.change })),
  pending: S.pending.map((p) => ({ id: p.id, store: nameOf(p.store), value: p.value, status: p.status })),
});

const json = (res, status, v) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };
const body = async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString('utf8') || '{}'); };
const files = { '/': 'app.html', '/title': 'title.html', '/logo.png': 'logo.png' };
const types = { html: 'text/html; charset=utf-8', png: 'image/png' };
const JA = [
  [/already taken|redeemed at|another store/i, 'このポイントは、すでに別のお店で使われています'],
  [/expired/i, '有効期限が切れています'],
];
const ja = (m) => JA.find(([re]) => re.test(m))?.[1] ?? m;

createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (files[p]) {
      res.writeHead(200, { 'content-type': types[files[p].split('.').pop()], 'cache-control': 'no-store' });
      return res.end(await readFile(join(here, files[p])));
    }
    if (p === '/api/reset' && req.method === 'POST') { await setup(); return json(res, 200, { ok: true }); }
    if (p === '/api/receipt') return json(res, 200, RECEIPT());
    if (p === '/api/app') { const got = await collect(); return json(res, 200, { ...view(), got }); }

    // 1. The app reads the bakery's paper receipt and claims it with a fresh key.
    if (p === '/api/claim' && req.method === 'POST') {
      const { lines, ...receipt } = RECEIPT();
      const key = await generateKey();
      const c = await S.client.submit({ receipt, holder: key.publicJwk });
      S.pending.push({ id: c.id, key, store: receipt.store, value: c.value, status: c.status, note: 'レシート' });
      return json(res, 200, { status: c.status, value: c.value, ...view() });
    }
    // Someone who photographed the receipt claims the same number, with another total.
    if (p === '/api/copycat' && req.method === 'POST') {
      const { lines, ...receipt } = RECEIPT();
      const c = await S.client.submit({ receipt: { ...receipt, total: 9800, at: receipt.at.replace('17:42', '17:58') }, holder: (await generateKey()).publicJwk });
      return json(res, 200, { status: c.status });
    }
    // 2. The bakery's daily review.
    if (p === '/api/desk') {
      const list = await storeClaims(S.stores.komugi, S.client);
      return json(res, 200, { claims: list.map((c) => ({ id: c.id, status: c.status, number: c.receipt.number, at: c.receipt.at, total: c.receipt.total, value: c.value, submitted: c.submitted })) });
    }
    if (p === '/api/desk/approve' && req.method === 'POST') {
      const answered = await approveReceipts(S.stores.komugi, S.client);
      return json(res, 200, { answered });
    }
    // 3. The café shows a signed QR on its customer display; the app scans it.
    if (p === '/api/kissa/qr' && req.method === 'POST') {
      const now = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
      const token = await S.stores.kissa.signReceipt({ at: now, number: '0007', total: 640 });
      S.qr = receiptQr(S.program, token);
      return json(res, 200, { svg: await QRCode.toString(S.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' }), total: 640, points: 6 });
    }
    if (p === '/api/scan' && req.method === 'POST') {
      const { token, service: url } = parseReceiptQr(S.qr);
      const key = await generateKey();
      const c = await new DeskClient(url).submit({ token, holder: key.publicJwk });
      S.pending.push({ id: c.id, key, store: SHOPS.kissa.id, value: c.value, status: c.status, note: 'QR' });
      return json(res, 200, { status: c.status, value: c.value, ...view() });
    }
    if (p === '/api/kissa/sync' && req.method === 'POST') {
      const done = await syncReceipts(S.stores.kissa, S.client);
      return json(res, 200, { done });
    }
    // 4. Paying 20 points at the gift shop: whole vouchers first, then part of one, with change.
    if (p === '/api/pay' && req.method === 'POST') {
      let left = Number((await body(req)).amount) || 20;
      const used = [];
      for (const h of [...S.held].sort((a, b) => b.value - a.value)) {
        if (!left) break;
        const w = new Wallet(h.key.privateJwk, h.key.publicJwk);
        if (h.value <= left) {
          await w.redeemAt(S.stores.tsumugi, h.voucher);
          left -= h.value;
          used.push({ from: nameOf(h.issuer), value: h.value });
        } else {
          const ck = await generateKey();
          const r = await w.redeemAt(S.stores.tsumugi, h.voucher, new Date(), { amount: left, change: ck.publicJwk });
          used.push({ from: nameOf(h.issuer), value: left, change: h.value - left });
          await keep(r.change, ck, 'お釣り');
          left = 0;
        }
        S.held = S.held.filter((x) => x !== h);
        S.spent.push(h);
      }
      return json(res, 200, { used, ...view() });
    }
    // 5. A copy of the app tries the spent 18 points again, at the café.
    if (p === '/api/copy' && req.method === 'POST') {
      const h = S.spent.find((x) => x.value === 18) ?? S.spent[0];
      if (!h) return json(res, 200, { ok: false, error: 'まだ使ったポイントがありません' });
      try {
        await new Wallet(h.key.privateJwk, h.key.publicJwk).redeemAt(S.stores.kissa, h.voucher);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 200, { ok: false, value: h.value, error: ja(e.message), detail: e.message });
      }
    }
    // 6. The operator settles from each shop's record.
    if (p === '/api/settle') {
      const claims = await Promise.all(Object.values(S.stores).map((s) => s.claim()));
      const out = await settle(S.program, S.programJson, claims);
      const records = claims.map((c) => ({ store: nameOf(c.store), events: c.records.map((r) => ({ event: r.event, digest: r.digest, meta: r.meta ?? {} })) }));
      return json(res, 200, { statements: out.statements.map((s) => ({ ...s, name: nameOf(s.store) })), findings: out.findings, records });
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', async () => { await setup(); console.log(`demo on http://127.0.0.1:${PORT}`); });
