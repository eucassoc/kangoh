import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { SignJWT, decodeJwt } from 'jose';
import { sha256, sha256b64url } from '../src/digest.js';
import { VoucherError } from '../src/errors.js';
import { ALG, generateKey, signingKey, type KeyPair } from '../src/keys.js';
import { KB_TYP, verifyPresentation } from '../src/presentation.js';
import { parseProgram, type Program } from '../src/program.js';
import { MemoryRecorder } from '../src/record.js';
import { Registry, registryServer } from '../src/registry.js';
import { settle } from '../src/settlement.js';
import { Store } from '../src/store.js';
import { issueChange, splitVoucher, verifyVoucher, type VoucherClaims } from '../src/voucher.js';
import { Wallet } from '../src/wallet.js';
import { Clock } from './program.test.js';

async function street(opts: { registry?: boolean; change?: boolean } = { registry: true, change: true }) {
  const clock = new Clock(new Date('2026-04-01T09:00:00Z'));
  const ids = ['bakery.example', 'cafe.example', 'bookshop.example'];
  const keys = new Map<string, KeyPair>();
  for (const id of ids) keys.set(id, await generateKey());
  const operator = await generateKey();
  const program: Program = {
    name: 'arcade.example',
    earn: { per: 100, points: 1 },
    validDays: 30,
    operator: { id: 'operator.arcade.example', key: operator.publicJwk },
    stores: ids.map((id) => ({ id, key: (keys.get(id) as KeyPair).publicJwk })),
  };
  const programJson = JSON.stringify(program);
  const registry = new Registry({ program, now: clock.now, ...(opts.change === false ? {} : { changeKey: operator.privateJwk }) });
  const server = registryServer({ registry });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stores = new Map<string, Store>();
  for (const id of ids) {
    const s = new Store({
      id,
      privateJwk: (keys.get(id) as KeyPair).privateJwk,
      program,
      programJson,
      recorder: new MemoryRecorder(),
      now: clock.now,
      ...(opts.registry === false ? {} : { registry: { url } }),
    });
    await s.join();
    stores.set(id, s);
  }
  return {
    clock,
    program,
    programJson,
    operator,
    registry,
    url,
    store: (id: string) => stores.get(id) as Store,
    claims: () => Promise.all([...stores.values()].map((s) => s.claim())),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function wallet() {
  const k = await generateKey();
  return new Wallet(k.privateJwk, k.publicJwk);
}

const claimsOf = (v: string) => decodeJwt(splitVoucher(v).jwt) as unknown as VoucherClaims;

test('part of a voucher: the store takes it, the operator issues the rest as change, and the original store pays it all', async () => {
  const s = await street();
  try {
    const w = await wallet();
    const v18 = await s.store('bakery.example').issue(w.publicJwk, { value: 18 });

    // 9 of the 18 at the café; the change comes back from the counter.
    const k1 = await generateKey();
    const r1 = await w.redeemAt(s.store('cafe.example'), v18, s.clock.now(), { amount: 9, change: k1.publicJwk });
    assert.equal(r1.amount, 9);
    const change = r1.change as string;
    const c1 = await verifyVoucher(s.program, change);
    assert.equal(c1.iss, 'operator.arcade.example');
    assert.equal(c1.value, 9);
    assert.deepEqual(c1.chg, { parent: sha256(v18), origin: 'bakery.example' });
    assert.equal(c1.cnf.jwk.x, k1.publicJwk.x);
    assert.equal(c1.exp, claimsOf(v18).exp);
    // The change can be fetched by the wallet, if the counter did not hand it back.
    assert.deepEqual(await (await fetch(`${s.url}/change/${sha256(v18)}`)).json(), { change });

    // The change, used in part again at the bookshop: change of change still names the bakery.
    s.clock.advance(3600_000);
    const w1 = new Wallet(k1.privateJwk, k1.publicJwk);
    const k2 = await generateKey();
    const r2 = await w1.redeemAt(s.store('bookshop.example'), change, s.clock.now(), { amount: 4, change: k2.publicJwk });
    const c2 = await verifyVoucher(s.program, r2.change as string);
    assert.deepEqual([c2.value, c2.chg?.origin], [5, 'bakery.example']);

    // The last 5 spent whole, back at the bakery.
    s.clock.advance(3600_000);
    const r3 = await new Wallet(k2.privateJwk, k2.publicJwk).redeemAt(s.store('bakery.example'), r2.change as string, s.clock.now());
    assert.equal(r3.amount, 5);
    assert.equal(r3.change, undefined);

    const out = await settle(s.program, s.programJson, await s.claims());
    assert.deepEqual(out.findings, []);
    const by = (id: string) => out.statements.find((x) => x.store === id);
    assert.equal(by('bakery.example')?.pays, 13);
    assert.equal(by('bakery.example')?.own, 1);
    assert.equal(by('cafe.example')?.receives, 9);
    assert.equal(by('bookshop.example')?.receives, 4);

    // The registry answers a retry from the same store with the same change.
    const retry = await w.present(v18, 'cafe.example', 'retry', s.clock.now(), { amount: 9, change: k1.publicJwk });
    const again = await s.registry.claim('cafe.example', retry);
    assert.equal(again.change, change);
  } finally {
    await s.close();
  }
});

test('without a registry that issues change, part of a voucher is refused at the counter; the whole voucher is not', async () => {
  for (const opts of [{ registry: false }, { registry: true, change: false }]) {
    const s = await street(opts);
    try {
      const w = await wallet();
      const v = await s.store('bakery.example').issue(w.publicJwk, { value: 18 });
      await assert.rejects(w.redeemAt(s.store('cafe.example'), v, s.clock.now(), { amount: 9, change: (await generateKey()).publicJwk }), (e: VoucherError) => e.code === 'change');
      const whole = await w.redeemAt(s.store('cafe.example'), v, s.clock.now());
      assert.equal(whole.amount, 18);
    } finally {
      await s.close();
    }
  }
  // A registry that cannot be reached: no change, so no partial use.
  const s = await street();
  await s.close();
  const w = await wallet();
  const v = await s.store('bakery.example').issue(w.publicJwk, { value: 18 });
  await assert.rejects(w.redeemAt(s.store('cafe.example'), v, s.clock.now(), { amount: 9, change: (await generateKey()).publicJwk }), /cannot be reached/);
});

test('a partial presentation needs an amount within the value and a key for the change', async () => {
  const s = await street();
  try {
    const w = await wallet();
    const v = await s.store('bakery.example').issue(w.publicJwk, { value: 18 });
    const kb = async (extra: object) =>
      splitVoucher(v).voucher +
      (await new SignJWT({ nonce: 'n', sd_hash: sha256b64url(splitVoucher(v).voucher), ...extra })
        .setProtectedHeader({ alg: ALG, typ: KB_TYP })
        .setIssuedAt()
        .setAudience('cafe.example')
        .sign(await signingKey(w.privateJwk)));
    await assert.rejects(verifyPresentation(s.program, await kb({ amount: 19, change: { jwk: (await generateKey()).publicJwk } }), { aud: 'cafe.example' }), /between 1 and/);
    await assert.rejects(verifyPresentation(s.program, await kb({ amount: 9 }), { aud: 'cafe.example' }), /needs a public key for the change/);
    assert.equal((await verifyPresentation(s.program, await kb({ amount: 18 }), { aud: 'cafe.example' })).kb.amount, 18);
  } finally {
    await s.close();
  }
});

test('the operator cannot make points: change it signs on its own is found at settlement', async () => {
  const s = await street();
  try {
    const w = await wallet();
    const v = await s.store('bakery.example').issue(w.publicJwk, { value: 18 });
    const k = await generateKey();
    const r = await w.redeemAt(s.store('cafe.example'), v, s.clock.now(), { amount: 9, change: k.publicJwk });
    const parent = { digest: sha256(v), claims: claimsOf(v) };

    // A second change for the same voucher, to the key the holder named.
    const second = await issueChange(s.program, s.operator.privateJwk, parent, k.publicJwk, 9, s.clock.now());
    // Change worth more than the rest.
    const k2 = await generateKey();
    const v2 = await s.store('bakery.example').issue(k2.publicJwk, { value: 10 });
    const k3 = await generateKey();
    await new Wallet(k2.privateJwk, k2.publicJwk).redeemAt(s.store('cafe.example'), v2, s.clock.now(), { amount: 4, change: k3.publicJwk });
    const inflated = await issueChange(s.program, s.operator.privateJwk, { digest: sha256(v2), claims: claimsOf(v2) }, k3.publicJwk, 60, s.clock.now());
    // Change for a voucher nobody redeemed.
    const k4 = await generateKey();
    const v4 = await s.store('bakery.example').issue(k4.publicJwk, { value: 7 });
    const made = await issueChange(s.program, s.operator.privateJwk, { digest: sha256(v4), claims: claimsOf(v4) }, k4.publicJwk, 7, s.clock.now());

    s.clock.advance(60_000);
    await new Wallet(k.privateJwk, k.publicJwk).redeemAt(s.store('bookshop.example'), r.change as string, s.clock.now());
    s.clock.advance(60_000);
    await new Wallet(k.privateJwk, k.publicJwk).redeemAt(s.store('bookshop.example'), second, s.clock.now());
    await new Wallet(k3.privateJwk, k3.publicJwk).redeemAt(s.store('bookshop.example'), inflated, s.clock.now());
    await new Wallet(k4.privateJwk, k4.publicJwk).redeemAt(s.store('bookshop.example'), made, s.clock.now());

    const out = await settle(s.program, s.programJson, await s.claims());
    assert.deepEqual(
      out.findings.map((f) => f.problem.replace(/record \d+/, 'record N')),
      [
        'a second change for the voucher redeemed at cafe.example record N',
        'change does not match the rest of the voucher redeemed at cafe.example record N',
        'change from operator.arcade.example for a voucher no store redeemed; change issued without a purchase',
      ],
    );
    assert.equal(out.statements.find((x) => x.store === 'bookshop.example')?.receives, 9);
  } finally {
    await s.close();
  }
});

test('only the operator named in the program issues change', async () => {
  const k = await generateKey();
  assert.throws(
    () => parseProgram(JSON.stringify({ name: 'x', value: 1, validDays: 1, operator: { id: 'a', key: k.publicJwk }, stores: [{ id: 'a', key: k.publicJwk }] })),
    /operator id must differ/,
  );
  const s = await street();
  try {
    const w = await wallet();
    const v = await s.store('bakery.example').issue(w.publicJwk, { value: 18 });
    // Change signed by a store's key, or by a key that is not the operator's, is refused.
    const notOperator = await generateKey();
    await assert.rejects(issueChange(s.program, notOperator.privateJwk, { digest: sha256(v), claims: claimsOf(v) }, w.publicJwk, 3), /not the operator key/);
  } finally {
    await s.close();
  }
});
