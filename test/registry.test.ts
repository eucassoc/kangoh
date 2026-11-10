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
import { sha256 } from '../src/digest.js';
import { generateKey } from '../src/keys.js';
import type { Program } from '../src/program.js';
import { storeToken } from '../src/receipt.js';

async function start(program: Program, file?: string, now?: () => Date) {
  const registry = new Registry({ program, ...(file ? { file } : {}), ...(now ? { now } : {}) });
  await registry.load();
  const server = registryServer({ registry });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { registry, server, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('with a registry, a voucher spent at one store is refused at the next, at the counter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kangoh-registry-'));
  const file = join(dir, 'claims.jsonl');
  const f = await fixture();
  const reg = await start(f.program, file, f.clock.now);
  try {
    const stores = f.stores.map(
      (s) =>
        new Store({
          id: s.id,
          privateJwk: f.keys.get(s.id)!.privateJwk,
          program: f.program,
          programJson: f.programJson,
          recorder: new MemoryRecorder(),
          now: f.clock.now,
          registry: { url: reg.url },
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
    const again = await start(f.program, file, f.clock.now);
    try {
      assert.equal(again.registry.size, 1);
      const toBookshop = await a.present(v, 'bookshop.example', 'n', f.clock.now());
      await assert.rejects(again.registry.claim('bookshop.example', toBookshop), /already redeemed at cafe.example/);
      const toCafe = await a.present(v, 'cafe.example', 'n2', f.clock.now());
      assert.equal((await again.registry.claim('cafe.example', toCafe)).claimed, false);
    } finally {
      await again.close();
    }
  } finally {
    await reg.close().catch(() => {});
  }
});

test('only a store, with its own key, can claim, and only a voucher presented to it', async () => {
  const f = await fixture();
  const reg = await start(f.program, undefined, f.clock.now);
  try {
    const [bakery, cafe] = f.stores as [Store, Store];
    const a = await wallet();
    const v = await bakery.issue(a.publicJwk);
    const toCafe = await a.present(v, 'cafe.example', 'n', f.clock.now());
    const post = (body: unknown, auth?: string) =>
      fetch(`${reg.url}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify(body) });

    // No token: refused.
    assert.equal((await post({ presentation: toCafe })).status, 401);
    // A token signed with a key that is not the store's: refused.
    const forged = await storeToken('cafe.example', (await generateKey()).privateJwk, f.clock.now());
    assert.equal((await post({ presentation: toCafe }, `Store ${forged}`)).status, 401);
    // The issuing store cannot mark its own voucher spent to keep others from
    // taking it: it holds no presentation of it signed for itself.
    const bakeryToken = `Store ${await bakery.serviceToken()}`;
    assert.equal((await post({ presentation: toCafe }, bakeryToken)).status, 400);
    assert.equal(reg.registry.size, 0);
    // A digest alone is no longer enough.
    assert.equal((await post({ voucher: sha256(v), store: 'bakery.example' }, bakeryToken)).status, 400);
    // The café, with its own token and the customer's presentation to it, can.
    const ok = await post({ presentation: toCafe }, `Store ${await cafe.serviceToken()}`);
    assert.equal(ok.status, 200);
    // Lookups need a store token too.
    assert.equal((await fetch(`${reg.url}/spent/${sha256(v)}`)).status, 401);
    const spent = (await (await fetch(`${reg.url}/spent/${sha256(v)}`, { headers: { authorization: bakeryToken } })).json()) as { spent: boolean; store: string };
    assert.deepEqual([spent.spent, spent.store], [true, 'cafe.example']);
    const health = (await (await fetch(`${reg.url}/health`)).json()) as { claims: number };
    assert.equal(health.claims, 1);
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
