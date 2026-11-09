import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ReceiptDesk } from '../src/desk.js';
import { approveReceipts, DeskClient, rejectReceipt, storeClaims, syncReceipts } from '../src/deskClient.js';
import { sha256 } from '../src/digest.js';
import { VoucherError } from '../src/errors.js';
import { generateKey, type KeyPair } from '../src/keys.js';
import { earned, parseProgram, type Program } from '../src/program.js';
import { parseReceiptQr, receiptQr } from '../src/receipt.js';
import { MemoryRecorder } from '../src/record.js';
import { Registry, registryServer } from '../src/registry.js';
import { settle } from '../src/settlement.js';
import { Store } from '../src/store.js';
import { issueVoucher } from '../src/voucher.js';
import { Wallet } from '../src/wallet.js';
import { Clock } from './program.test.js';

// A street of three: the bakery and the bookshop have their receipts
// reviewed, the café prints a signed QR on its receipts.
async function street(dir?: string) {
  const clock = new Clock(new Date('2026-04-01T09:00:00Z'));
  const ids = ['bakery.example', 'cafe.example', 'bookshop.example'];
  const keys = new Map<string, KeyPair>();
  for (const id of ids) keys.set(id, await generateKey());
  const desk0 = { registry: new Registry() };
  const program: Program = {
    name: 'arcade.example',
    value: 100,
    earn: { per: 100, points: 1, max: 500 },
    validDays: 90,
    receiptDays: 7,
    stores: ids.map((id) => ({ id, key: (keys.get(id) as KeyPair).publicJwk, ...(id === 'cafe.example' ? { receipts: 'signed' as const } : {}) })),
  };
  const programJson = JSON.stringify(program);
  const stores = new Map<string, Store>();
  for (const id of ids) {
    const s = new Store({ id, privateJwk: (keys.get(id) as KeyPair).privateJwk, program, programJson, recorder: new MemoryRecorder(), now: clock.now });
    await s.join();
    stores.set(id, s);
  }
  const files = dir ? { state: join(dir, 'receipts.jsonl'), chain: join(dir, 'receipts.chain.jsonl') } : {};
  const desk = new ReceiptDesk({ program, secret: 'desk-secret', ...files, now: clock.now });
  await desk.load();
  const server = registryServer({ ...desk0, desk });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  program.service = url;
  return {
    clock,
    program,
    programJson,
    stores,
    desk,
    url,
    client: new DeskClient(url),
    store: (id: string) => stores.get(id) as Store,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const receipt = (store: string, number: string, total: number, at = '2026-04-01T17:30') => ({ store, at, number, total });

test('a printed receipt: claimed by the app, approved by the store once a day, spent at another store, settled by value', async () => {
  const s = await street();
  try {
    const key = await generateKey();
    const c = await s.client.submit({ receipt: receipt('bakery.example', 'R01-0042', 1850), holder: key.publicJwk });
    assert.equal(c.status, 'pending');
    assert.equal(c.value, 18);
    assert.equal((await s.client.status(c.id)).voucher, undefined);

    // The day's review: the bakery checks the claim against its sales and approves.
    const listed = await storeClaims(s.store('bakery.example'), s.client);
    assert.deepEqual(listed.map((x) => [x.status, x.receipt.number, x.value]), [['pending', 'R01-0042', 18]]);
    const [answer] = await approveReceipts(s.store('bakery.example'), s.client);
    assert.equal(answer?.status, 'issued');

    const got = await s.client.status(c.id);
    assert.equal(got.status, 'issued');
    const voucher = got.voucher as string;
    const w = new Wallet(key.privateJwk, key.publicJwk);
    w.add(voucher);

    s.clock.advance(3600_000);
    const r = await w.redeemAt(s.store('bookshop.example'), w.take(s.clock.now()) as string, s.clock.now());
    assert.equal(r.claims.value, 18);

    const claims = await Promise.all([...s.stores.values()].map((x) => x.claim()));
    const out = await settle(s.program, s.programJson, claims);
    assert.deepEqual(out.findings, []);
    const bakery = out.statements.find((x) => x.store === 'bakery.example');
    const bookshop = out.statements.find((x) => x.store === 'bookshop.example');
    assert.equal(bakery?.pays, 18);
    assert.equal(bookshop?.receives, 18);
    // The bakery's record says which claim the voucher answered.
    const issued = (await s.store('bakery.example').claim()).records.find((x) => x.event === 'issued');
    assert.equal(issued?.meta?.claim, c.id);
    assert.equal(issued?.digest, sha256(voucher));
  } finally {
    await s.close();
  }
});

test('a receipt is claimed once: the first claim wins, a later one is refused and shown to the store as an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kangoh-desk-'));
  const s = await street(dir);
  try {
    const first = await s.client.submit({ receipt: receipt('bakery.example', 'R01-0042', 1850), holder: (await generateKey()).publicJwk });
    // The same receipt, number typed with full-width digits and a space.
    const again = await s.client.submit({ receipt: receipt('bakery.example', 'R01-００４２ ', 1850, '2026-04-01T17:31'), holder: (await generateKey()).publicJwk });
    assert.equal(first.status, 'pending');
    assert.equal(again.status, 'duplicate');
    assert.match(again.reason ?? '', /claimed first/);
    assert.equal((await s.client.status(again.id)).status, 'duplicate');
    // Another day's receipt with the same number is another receipt.
    const nextDay = await s.client.submit({ receipt: receipt('bakery.example', 'R01-0042', 900, '2026-04-02T08:00'), holder: (await generateKey()).publicJwk });
    assert.equal(nextDay.status, 'pending');

    const listed = await storeClaims(s.store('bakery.example'), s.client);
    assert.deepEqual(
      listed.map((x) => x.status),
      ['duplicate', 'pending', 'pending'],
    );
    const answers = await approveReceipts(s.store('bakery.example'), s.client);
    assert.deepEqual(answers.map((a) => a.status).sort(), ['issued', 'issued']);
    assert.equal((await s.client.status(again.id)).status, 'duplicate');

    // The public chain: one record per outcome, linked, with an HMAC of the receipt and no totals or keys.
    const lines = (await readFile(join(dir, 'receipts.chain.jsonl'), 'utf8')).split('\n').filter(Boolean);
    const records = lines.map((l) => JSON.parse(l));
    assert.equal(records.length, 5);
    records.forEach((r, i) => {
      assert.equal(r.spec, 'deedlog/v0.1');
      assert.equal(r.seq, i);
      assert.equal(r.prev, i ? 'sha256:' + sha256(lines[i - 1] as string) : undefined);
    });
    const dup = records.find((r) => r.meta.status === 'duplicate');
    assert.equal(dup.meta.duplicate_of, first.id);
    assert.equal(dup.meta.receipt, records[0].meta.receipt);
    assert.doesNotMatch(lines.join('\n'), /1850|R01-0042|"x"/);
    // The private state is what the chain points to.
    const state = (await readFile(join(dir, 'receipts.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(records[0].subject.digest.sha256, sha256(state[0] as string));

    // A restarted desk knows the receipt is taken and continues the chain.
    const desk = new ReceiptDesk({ program: s.program, secret: 'desk-secret', state: join(dir, 'receipts.jsonl'), chain: join(dir, 'receipts.chain.jsonl'), now: s.clock.now });
    await desk.load();
    assert.equal(desk.size, 3);
    const third = await desk.submit({ receipt: receipt('bakery.example', 'R01-0042', 1850), holder: (await generateKey()).publicJwk });
    assert.equal(third.status, 'duplicate');
    const after = (await readFile(join(dir, 'receipts.chain.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.equal(JSON.parse(after[5] as string).prev, 'sha256:' + sha256(lines[4] as string));
  } finally {
    await s.close();
  }
});

test('a signed receipt QR: issued at the store\'s next sync without review; printed claims for that store are refused', async () => {
  const s = await street();
  try {
    const cafe = s.store('cafe.example');
    const qr = receiptQr(s.program, await cafe.signReceipt({ at: '2026-04-01T12:05', number: '0007', total: 640 }));
    assert.ok(qr.startsWith(`${s.url}/r#`));
    const parsed = parseReceiptQr(qr);
    assert.equal(parsed.service, s.url);
    const page = await fetch(qr.slice(0, qr.indexOf('#')));
    assert.match(await page.text(), /QR/);

    const key = await generateKey();
    const c = await new DeskClient(parsed.service as string).submit({ token: parsed.token, holder: key.publicJwk });
    assert.equal(c.status, 'authorized');
    assert.equal(c.value, 6);
    assert.equal(c.signed, true);

    const done = await syncReceipts(cafe, s.client);
    assert.deepEqual(done.map((d) => [d.status, d.value]), [['issued', 6]]);
    assert.deepEqual(await syncReceipts(cafe, s.client), []);
    assert.ok((await s.client.status(c.id)).voucher);

    // The same QR again is a duplicate.
    const again = await s.client.submit({ token: parsed.token, holder: (await generateKey()).publicJwk });
    assert.equal(again.status, 'duplicate');
    // The café prints QRs, so a claim typed from its receipt is refused.
    await assert.rejects(s.client.submit({ receipt: receipt('cafe.example', '0008', 640), holder: key.publicJwk }), /scan the QR/);
    // A QR signed by another key is refused.
    const forged = await (await generateKey()).privateJwk;
    await assert.rejects(
      s.client.submit({ token: (await new Store({ id: 'cafe.example', privateJwk: forged, program: s.program, programJson: s.programJson, recorder: new MemoryRecorder() }).signReceipt({ at: '2026-04-01T12:06', number: '9', total: 640 }).catch((e) => e.message)) as string, holder: key.publicJwk }),
      /./,
    );
  } finally {
    await s.close();
  }
});

test('stores read and answer only their own claims, with a token signed by their key', async () => {
  const s = await street();
  try {
    const c = await s.client.submit({ receipt: receipt('bakery.example', 'A-1', 500), holder: (await generateKey()).publicJwk });
    const res = await fetch(`${s.url}/receipts`);
    assert.equal(res.status, 401);
    const stranger = new Store({ id: 'bakery.example', privateJwk: (await generateKey()).privateJwk, program: s.program, programJson: s.programJson, recorder: new MemoryRecorder(), now: s.clock.now });
    await assert.rejects(s.client.list(await stranger.serviceToken()), /not signed by bakery/);
    assert.deepEqual(await s.client.list(await s.store('bookshop.example').serviceToken()), []);
    // The bookshop cannot answer the bakery's claim.
    await assert.rejects(rejectReceipt(s.store('bookshop.example'), s.client, c.id, 'not ours'), /no claim/);
    // A voucher for another key is refused.
    const wrong = await issueVoucher(s.program, { id: 'bakery.example', privateJwk: (await generateKey()).privateJwk }, (await generateKey()).publicJwk, s.clock.now(), 5).catch((e: VoucherError) => e);
    assert.ok(wrong instanceof VoucherError);
    const other = await s.store('bakery.example').issue((await generateKey()).publicJwk, { value: 5 });
    await assert.rejects(s.client.issue(await s.store('bakery.example').serviceToken(), c.id, other), /not bound to the claim's key/);
    // An expired token is refused.
    const old = await s.store('bakery.example').serviceToken();
    s.clock.advance(600_000);
    await assert.rejects(s.client.list(old), /expired/);
  } finally {
    await s.close();
  }
});

test('the store refuses a claim with a reason the customer sees; a corrected total changes the points', async () => {
  const s = await street();
  try {
    const bad = await s.client.submit({ receipt: receipt('bookshop.example', '77', 3000), holder: (await generateKey()).publicJwk });
    const misread = await s.client.submit({ receipt: receipt('bookshop.example', '78', 8800), holder: (await generateKey()).publicJwk });
    await rejectReceipt(s.store('bookshop.example'), s.client, bad.id, 'no such receipt number');
    const seen = await s.client.status(bad.id);
    assert.equal(seen.status, 'rejected');
    assert.equal(seen.reason, 'no such receipt number');
    await assert.rejects(rejectReceipt(s.store('bookshop.example'), s.client, bad.id, 'again'), /is rejected/);
    const [a] = await approveReceipts(s.store('bookshop.example'), s.client, { ids: [misread.id], totals: { [misread.id]: 880 } });
    assert.equal(a?.value, 8);
    assert.equal((await s.client.status(misread.id)).value, 8);
  } finally {
    await s.close();
  }
});

test('receipts that cannot be claimed: too old, in the future, earning nothing, from outside the program', async () => {
  const s = await street();
  try {
    const holder = (await generateKey()).publicJwk;
    await assert.rejects(s.client.submit({ receipt: receipt('bakery.example', '1', 1000, '2026-03-20T10:00'), holder }), /can be claimed for 7 days/);
    await assert.rejects(s.client.submit({ receipt: receipt('bakery.example', '2', 1000, '2026-04-05T10:00'), holder }), /future/);
    await assert.rejects(s.client.submit({ receipt: receipt('bakery.example', '3', 99), holder }), /earns no points/);
    await assert.rejects(s.client.submit({ receipt: receipt('florist.example', '4', 1000), holder }), /not in the program/);
    await assert.rejects(s.client.submit({ receipt: receipt('bakery.example', '5', 1000), holder: { kty: 'OKP', crv: 'Ed25519', x: holder.x as string, d: 'secret' } }), /public Ed25519/);
    await assert.rejects(s.client.submit({ receipt: { store: 'bakery.example', at: 'yesterday', number: '6', total: 1000 }, holder }), /YYYY-MM-DDTHH:MM/);
    assert.equal(s.desk.size, 0);
  } finally {
    await s.close();
  }
});

test('points earned from a total, and the vouchers a program allows', async () => {
  const p = parseProgram(JSON.stringify({ name: 'x', earn: { per: 100, points: 1, max: 50 }, validDays: 30, stores: [{ id: 'a', key: {} }] }));
  assert.equal(earned(p, 1850), 18);
  assert.equal(earned(p, 99), 0);
  assert.equal(earned(p, 999_999), 50);
  assert.throws(() => parseProgram(JSON.stringify({ name: 'x', validDays: 30, stores: [{ id: 'a', key: {} }] })), /value or earn/);
  assert.throws(() => parseProgram(JSON.stringify({ name: 'x', value: 1, validDays: 30, stores: [{ id: 'a', key: {}, receipts: 'maybe' }] })), /review or signed/);
  // A fixed-value program takes no other value.
  const k = await generateKey();
  const fixed: Program = { name: 'fixed', value: 100, validDays: 7, stores: [{ id: 'a', key: k.publicJwk }] };
  await assert.rejects(issueVoucher(fixed, { id: 'a', privateJwk: k.privateJwk }, k.publicJwk, new Date(), 5), /does not fit/);
});
