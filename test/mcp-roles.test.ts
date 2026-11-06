import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JWK } from 'jose';
import { generateKey } from '../src/keys.js';
import type { Program } from '../src/program.js';
import { openStore } from '../src/storeDir.js';

async function start(role: string, env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/src/mcp.js', role], env: { ...(process.env as Record<string, string>), ...env } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error((r.content as { text?: string }[])[0]?.text ?? 'tool error');
  return r.structuredContent as Record<string, unknown>;
}

test('a store issues and redeems, and the operator settles, through the MCP servers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'walife-'));
  const keys = { bakery: await generateKey(), cafe: await generateKey() };
  const program: Program = {
    name: 'arcade.example',
    value: 100,
    validDays: 7,
    stores: [
      { id: 'bakery.example', key: keys.bakery.publicJwk },
      { id: 'cafe.example', key: keys.cafe.publicJwk },
    ],
  };
  const programPath = join(dir, 'program.json');
  await writeFile(programPath, JSON.stringify(program));
  const dirs: Record<string, string> = {};
  for (const [name, id] of [
    ['bakery', 'bakery.example'],
    ['cafe', 'cafe.example'],
  ] as const) {
    dirs[name] = join(dir, name);
    await (await import('node:fs/promises')).mkdir(dirs[name]);
    await writeFile(join(dirs[name], 'store.json'), JSON.stringify({ id, privateJwk: keys[name].privateJwk }));
    await writeFile(join(dirs[name], 'program.json'), JSON.stringify(program));
  }

  const wallet = await start('wallet', { WALIFE_WALLET: join(dir, 'wallet.json') });
  const bakery = await start('store', { WALIFE_STORE: dirs.bakery! });
  const cafe = await start('store', { WALIFE_STORE: dirs.cafe! });
  const operator = await start('operator', {});
  try {
    assert.deepEqual((await bakery.listTools()).tools.map((t) => t.name).sort(), ['challenge', 'claim', 'issue_voucher', 'redeem_voucher']);
    assert.deepEqual((await operator.listTools()).tools.map((t) => t.name), ['settle']);

    // Checkout at the bakery: the agent gives its key, the bakery issues.
    const key = (await call(wallet, 'receiving_key')).jwk as JWK;
    const issued = await call(bakery, 'issue_voucher', { holder: key });
    await call(wallet, 'add_voucher', { voucher: issued.voucher, program: JSON.stringify(program) });

    // At the cafe: challenge, presentation, redemption.
    const ch = await call(cafe, 'challenge');
    const p = await call(wallet, 'present_voucher', { store: ch.store, challenge: ch.challenge });
    const r = await call(cafe, 'redeem_voucher', { presentation: p.presentation });
    assert.equal(r.issuer, 'bakery.example');
    assert.equal(r.voucher, issued.digest);
    await call(wallet, 'remove_voucher', { digest: issued.digest });
    // The same presentation is not taken twice.
    await assert.rejects(call(cafe, 'redeem_voucher', { presentation: p.presentation }), /challenge/);

    // The store's state survives a restart: the directory is the state.
    const reopened = await openStore(dirs.cafe!);
    const ch2 = (await reopened.claim()).records.map((x) => x.event);
    assert.deepEqual(ch2, ['program', 'redeemed']);

    // Settlement from the two claims, passed inline and as files.
    const bakeryClaim = await call(bakery, 'claim');
    const cafeClaim = await call(cafe, 'claim');
    const claimPath = join(dir, 'cafe-claim.json');
    await writeFile(claimPath, JSON.stringify(cafeClaim));
    const s = await call(operator, 'settle', { program: programPath, claims: [JSON.stringify(bakeryClaim), claimPath] });
    assert.deepEqual(s.findings, []);
    assert.deepEqual(s.statements, [
      { store: 'bakery.example', issued: 1, accepted: 0, own: 0, receives: 0, pays: 100 },
      { store: 'cafe.example', issued: 0, accepted: 1, own: 0, receives: 100, pays: 0 },
    ]);
  } finally {
    await Promise.all([wallet, bakery, cafe, operator].map((c) => c.close()));
  }
});
