import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKey } from '../src/keys.js';
import { present, verifyPresentation } from '../src/presentation.js';
import { issueVoucher, splitVoucher, verifyVoucher } from '../src/voucher.js';
import { DAY, fixture, wallet } from './program.test.js';

test('a voucher is an SD-JWT VC bound to the holder, verifiable from the program alone', async () => {
  const f = await fixture();
  const w = await wallet();
  const key = f.keys.get('bakery.example')!;
  const v = await issueVoucher(f.program, { id: 'bakery.example', privateJwk: key.privateJwk }, w.publicJwk, f.clock.now());
  assert.ok(v.endsWith('~'));
  const claims = await verifyVoucher(f.program, v, { at: f.clock.now() });
  assert.equal(claims.iss, 'bakery.example');
  assert.equal(claims.value, 100);
  assert.equal(claims.cnf.jwk.x, w.publicJwk.x);
  assert.equal(claims.exp - claims.iat, 7 * 86400);
  assert.equal(splitVoucher(v).kb, '');
});

test('issuance needs the key the program lists', async () => {
  const f = await fixture();
  const w = await wallet();
  const other = await generateKey();
  await assert.rejects(issueVoucher(f.program, { id: 'bakery.example', privateJwk: other.privateJwk }, w.publicJwk), /not the one in the program/);
  await assert.rejects(issueVoucher(f.program, { id: 'nobody.example', privateJwk: other.privateJwk }, w.publicJwk), /not in the program/);
});

test('a voucher from outside the program, or tampered with, is refused', async () => {
  const f = await fixture();
  const w = await wallet();
  const outsider = await generateKey();
  const rogue = { ...f.program, stores: [...f.program.stores, { id: 'rogue.example', key: outsider.publicJwk }] };
  const v = await issueVoucher(rogue, { id: 'rogue.example', privateJwk: outsider.privateJwk }, w.publicJwk);
  await assert.rejects(verifyVoucher(f.program, v), /not in the program/);
  const bakery = f.keys.get('bakery.example')!;
  const good = await issueVoucher(f.program, { id: 'bakery.example', privateJwk: bakery.privateJwk }, w.publicJwk);
  const [h, p, s] = good.slice(0, -1).split('.');
  const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
  payload.value = 10000;
  const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}~`;
  await assert.rejects(verifyVoucher(f.program, forged), /signature is not bakery.example's/);
});

test('a presentation binds the holder key, the store and the challenge', async () => {
  const f = await fixture();
  const w = await wallet();
  const bakery = f.keys.get('bakery.example')!;
  const v = await issueVoucher(f.program, { id: 'bakery.example', privateJwk: bakery.privateJwk }, w.publicJwk, f.clock.now());
  const p = await present(v, w.privateJwk, 'cafe.example', 'n1', f.clock.now());
  const ok = await verifyPresentation(f.program, p, { aud: 'cafe.example', nonce: 'n1', at: f.clock.now() });
  assert.equal(ok.voucher, v);
  assert.equal(ok.kb.nonce, 'n1');
  await assert.rejects(verifyPresentation(f.program, p, { aud: 'bookshop.example' }), /presented to cafe.example/);
  await assert.rejects(verifyPresentation(f.program, p, { aud: 'cafe.example', nonce: 'n2' }), /challenge does not match/);
  await assert.rejects(verifyPresentation(f.program, v, { aud: 'cafe.example' }), /not presented by its holder/);
  const thief = await wallet();
  const stolen = await present(v, thief.privateJwk, 'cafe.example', 'n1');
  await assert.rejects(verifyPresentation(f.program, stolen, { aud: 'cafe.example' }), /not signed by the holder/);
  f.clock.advance(8 * DAY);
  await assert.rejects(verifyPresentation(f.program, p, { aud: 'cafe.example', at: f.clock.now() }), /expired/);
  // Without `at`, expiry is the caller's business.
  await verifyPresentation(f.program, p, { aud: 'cafe.example' });
});
