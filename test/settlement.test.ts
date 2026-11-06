import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFinding, settle } from '../src/settlement.js';
import type { Store } from '../src/store.js';
import { DAY, fixture, wallet } from './program.test.js';

test('vouchers are settled between stores, each paid once', async () => {
  const f = await fixture();
  const [bakery, cafe, bookshop] = f.stores as [Store, Store, Store];
  const a = await wallet();
  const b = await wallet();
  // bakery issues two to a, cafe issues one to b; a spends at cafe and bakery, b at bookshop.
  a.add(await bakery.issue(a.publicJwk));
  a.add(await bakery.issue(a.publicJwk));
  b.add(await cafe.issue(b.publicJwk));
  f.clock.advance(DAY);
  await a.redeemAt(cafe, a.take(f.clock.now())!, f.clock.now());
  await a.redeemAt(bakery, a.take(f.clock.now())!, f.clock.now());
  await b.redeemAt(bookshop, b.take(f.clock.now())!, f.clock.now());
  const { findings, statements } = await settle(f.program, f.programJson, [await bakery.claim(), await cafe.claim(), await bookshop.claim()]);
  assert.deepEqual(findings, []);
  assert.deepEqual(statements, [
    { store: 'bakery.example', issued: 2, accepted: 0, own: 1, receives: 0, pays: 100 },
    { store: 'cafe.example', issued: 1, accepted: 1, own: 0, receives: 100, pays: 100 },
    { store: 'bookshop.example', issued: 0, accepted: 1, own: 0, receives: 100, pays: 0 },
  ]);
});

test('a double spend, an off-book voucher and an expired one are found and not paid', async () => {
  const f = await fixture(undefined, { acceptExpired: 'cafe.example' });
  const [bakery, cafe, bookshop] = f.stores as [Store, Store, Store];
  const a = await wallet();
  const v = await bakery.issue(a.publicJwk);
  const old = await bakery.issue(a.publicJwk);
  f.clock.advance(DAY);
  // a keeps a copy and presents it at two stores.
  await a.redeemAt(cafe, v, f.clock.now());
  f.clock.advance(60_000);
  await a.redeemAt(bookshop, v, f.clock.now());
  // bookshop's key signs a voucher that bookshop never records.
  const { issueVoucher } = await import('../src/voucher.js');
  const offBook = await issueVoucher(f.program, { id: 'bookshop.example', privateJwk: f.keys.get('bookshop.example')!.privateJwk }, a.publicJwk, f.clock.now());
  await a.redeemAt(bakery, offBook, f.clock.now());
  // cafe accepts a voucher 4 days after it expired.
  f.clock.advance(10 * DAY);
  await a.redeemAt(cafe, old, f.clock.now());
  const { findings, statements } = await settle(f.program, f.programJson, [await bakery.claim(), await cafe.claim(), await bookshop.claim()]);
  const text = findings.map(formatFinding);
  assert.deepEqual(text, [
    "bakery.example record 3: voucher signed with bookshop.example's key, but bookshop.example never recorded issuing it; off-book issuance or a stolen key",
    `bookshop.example record 1: voucher already redeemed at cafe.example record 1; holder ${(a.publicJwk.x as string).slice(0, 8)} presented it twice`,
    'cafe.example record 2: voucher from bakery.example (record 2) expired 4d00h before it was redeemed',
  ]);
  assert.deepEqual(statements, [
    { store: 'bakery.example', issued: 2, accepted: 0, own: 0, receives: 0, pays: 100 },
    { store: 'cafe.example', issued: 0, accepted: 1, own: 0, receives: 100, pays: 0 },
    { store: 'bookshop.example', issued: 0, accepted: 0, own: 0, receives: 0, pays: 0 },
  ]);
});

test('a claim must match its records', async () => {
  const f = await fixture();
  const [bakery, cafe] = f.stores as [Store, Store];
  const a = await wallet();
  const v = await bakery.issue(a.publicJwk);
  const r = await a.redeemAt(cafe, v, f.clock.now());
  const claim = await cafe.claim();
  const missing = { ...claim, presentations: {} };
  const swapped = { ...claim, presentations: { [r.record.digest]: claim.presentations[r.record.digest] + 'x' } };
  const wrongProgram = { ...(await bakery.claim()), records: [{ ...(await bakery.claim()).records[0]!, digest: 'ffff' }] };
  const { findings } = await settle(f.program, f.programJson, [wrongProgram, missing, swapped]);
  assert.deepEqual(
    findings.map((x) => x.problem),
    ['the program recorded is not the one being settled', 'no presentation submitted for this redemption', 'the submitted presentation is not the one recorded'],
  );
});
