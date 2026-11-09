import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { MemoryRecorder } from '../src/record.js';
import { Registry, registryServer } from '../src/registry.js';
import { settle } from '../src/settlement.js';
import { Store } from '../src/store.js';
import { DAY, fixture, wallet } from './program.test.js';

async function start(file?: string, token?: string) {
  const registry = new Registry(file);
  await registry.load();
  const server = registryServer({ registry, ...(token ? { token } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { registry, server, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('with a registry, a voucher spent at one store is refused at the next, at the counter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kangoh-registry-'));
  const file = join(dir, 'claims.jsonl');
  const reg = await start(file, 'secret');
  try {
    const f = await fixture();
    const stores = f.stores.map(
      (s) =>
        new Store({
          id: s.id,
          privateJwk: f.keys.get(s.id)!.privateJwk,
          program: f.program,
          programJson: f.programJson,
          recorder: new MemoryRecorder(),
          now: f.clock.now,
          registry: { url: reg.url, token: 'secret' },
        }),
    );
    for (const s of stores) await s.join();
    const [bakery, cafe, bookshop] = stores as [Store, Store, Store];
    const a = await wallet();
    const v = await bakery.issue(a.publicJwk);
    f.clock.advance(DAY);
    await a.redeemAt(cafe, v, f.clock.now());
    await assert.rejects(a.redeemAt(bookshop, v, f.clock.now()), (e: Error & { code?: string }) => e.code === 'spent' && /already redeemed at cafe.example/.test(e.message));
    // The bookshop recorded nothing, so settlement has nothing to reject.
    const { findings, statements } = await settle(f.program, f.programJson, [await bakery.claim(), await cafe.claim(), await bookshop.claim()]);
    assert.deepEqual(findings, []);
    assert.equal(statements[2]?.accepted, 0);
    // The registry file holds digests and store ids only, and survives a restart.
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, new RegExp(a.publicJwk.x as string));
    assert.match(text, /"store":"cafe.example"/);
    await reg.close();
    const again = await start(file, 'secret');
    try {
      assert.equal(again.registry.size, 1);
      await assert.rejects(again.registry.claim(JSON.parse(text).voucher, 'bookshop.example'), /already redeemed at cafe.example/);
      assert.equal((await again.registry.claim(JSON.parse(text).voucher, 'cafe.example')).claimed, false);
    } finally {
      await again.close();
    }
  } finally {
    await reg.close().catch(() => {});
  }
});

test('the registry refuses callers without the token, and answers spent lookups', async () => {
  const reg = await start(undefined, 'secret');
  try {
    const digest = 'a'.repeat(64);
    const r = await fetch(`${reg.url}/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voucher: digest, store: 'x' }) });
    assert.equal(r.status, 401);
    const ok = await fetch(`${reg.url}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ voucher: digest, store: 'x' }) });
    assert.equal(ok.status, 200);
    const spent = (await (await fetch(`${reg.url}/spent/${digest}`, { headers: { authorization: 'Bearer secret' } })).json()) as { spent: boolean; store: string };
    assert.deepEqual([spent.spent, spent.store], [true, 'x']);
    const health = (await (await fetch(`${reg.url}/health`)).json()) as { claims: number };
    assert.equal(health.claims, 1);
    const bad = await fetch(`${reg.url}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' }, body: JSON.stringify({ voucher: 'nope', store: 'x' }) });
    assert.equal(bad.status, 400);
  } finally {
    await reg.close();
  }
});

test('an unreachable registry is tolerated by default and fatal when required', async () => {
  const f = await fixture();
  const make = (required: boolean) =>
    new Store({
      id: 'cafe.example',
      privateJwk: f.keys.get('cafe.example')!.privateJwk,
      program: f.program,
      programJson: f.programJson,
      recorder: new MemoryRecorder(),
      now: f.clock.now,
      registry: { url: 'http://127.0.0.1:1', required, timeoutMs: 500 },
    });
  const bakery = f.stores[0] as Store;
  const a = await wallet();
  const lenient = make(false);
  await lenient.join();
  await a.redeemAt(lenient, await bakery.issue(a.publicJwk), f.clock.now());
  const strict = make(true);
  await strict.join();
  await assert.rejects(a.redeemAt(strict, await bakery.issue(a.publicJwk), f.clock.now()), /registry unreachable/);
});
