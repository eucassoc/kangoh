import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryRecorder } from '../src/record.js';
import { Store } from '../src/store.js';
import { DAY, fixture, wallet } from './program.test.js';

test('a store issues, redeems once, and records digests only', async () => {
  const f = await fixture();
  const [bakery, cafe] = f.stores as [Store, Store];
  const w = await wallet();
  const v = await bakery.issue(w.publicJwk);
  w.add(v);
  f.clock.advance(DAY);
  const r = await w.redeemAt(cafe, w.take(f.clock.now())!, f.clock.now());
  assert.equal(r.claims.iss, 'bakery.example');
  assert.equal(r.record.event, 'redeemed');
  assert.equal(r.record.meta?.issuer, 'bakery.example');
  const claim = await cafe.claim();
  assert.deepEqual(
    claim.records.map((x) => x.event),
    ['program', 'redeemed'],
  );
  assert.equal(claim.presentations[r.record.digest]?.startsWith(v), true);
  for (const rec of [...claim.records, ...(await bakery.claim()).records]) {
    assert.doesNotMatch(JSON.stringify(rec), new RegExp(w.publicJwk.x as string));
  }
  // The same voucher is not taken twice by the same store.
  await assert.rejects(w.redeemAt(cafe, v, f.clock.now()), /already redeemed here/);
});

test('a presentation cannot be replayed, and a challenge is used once', async () => {
  const f = await fixture();
  const [bakery, cafe] = f.stores as [Store, Store];
  const w = await wallet();
  const v = await bakery.issue(w.publicJwk);
  const nonce = cafe.challenge();
  const p = await w.present(v, cafe.id, nonce, f.clock.now());
  await cafe.redeem(p);
  await assert.rejects(cafe.redeem(p), /unknown or reused challenge/);
  await assert.rejects(cafe.redeem(await w.present(v, cafe.id, 'made-up', f.clock.now())), /unknown or reused challenge/);
});

test('an expired voucher is refused at the counter, and dropped by the wallet', async () => {
  const f = await fixture();
  const [bakery, cafe] = f.stores as [Store, Store];
  const w = await wallet();
  const v = await bakery.issue(w.publicJwk);
  w.add(v);
  f.clock.advance(8 * DAY);
  assert.equal(w.take(f.clock.now()), undefined);
  await assert.rejects(w.redeemAt(cafe, v, f.clock.now()), /expired/);
});

test('join must be the first record', async () => {
  const f = await fixture();
  const recorder = new MemoryRecorder();
  await recorder.append({ at: f.clock.now().toISOString(), event: 'issued', digest: 'x' });
  const s = new Store({ id: 'bakery.example', privateJwk: f.keys.get('bakery.example')!.privateJwk, program: f.program, programJson: f.programJson, recorder });
  await assert.rejects(s.join(), /join must come before/);
});
