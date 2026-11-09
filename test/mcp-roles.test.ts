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
import { ReceiptDesk } from '../src/desk.js';
import { Registry, registryServer } from '../src/registry.js';
import type { AddressInfo } from 'node:net';

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
  const dir = await mkdtemp(join(tmpdir(), 'kangoh-'));
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

  const wallet = await start('wallet', { KANGOH_WALLET: join(dir, 'wallet.json') });
  const bakery = await start('store', { KANGOH_STORE: dirs.bakery! });
  const cafe = await start('store', { KANGOH_STORE: dirs.cafe! });
  const operator = await start('operator', {});
  try {
    assert.deepEqual((await bakery.listTools()).tools.map((t) => t.name).sort(), [
      'approve_receipts',
      'challenge',
      'claim',
      'issue_voucher',
      'receipts',
      'redeem_voucher',
      'reject_receipt',
      'sync_receipts',
    ]);
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

test('receipts through the MCP servers: the agent claims, the store reviews and approves, the agent collects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kangoh-'));
  const keys = { bakery: await generateKey(), cafe: await generateKey() };
  const program: Program = {
    name: 'arcade.example',
    earn: { per: 100, points: 1 },
    validDays: 90,
    stores: [
      { id: 'bakery.example', key: keys.bakery.publicJwk },
      { id: 'cafe.example', key: keys.cafe.publicJwk, receipts: 'signed' },
    ],
  };
  const desk = new ReceiptDesk({ program, secret: 's' });
  const server = registryServer({ registry: new Registry(), desk });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  program.service = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
  const wallet = await start('wallet', { KANGOH_WALLET: join(dir, 'wallet.json') });
  const bakery = await start('store', { KANGOH_STORE: dirs.bakery! });
  const cafe = await start('store', { KANGOH_STORE: dirs.cafe! });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const printed = { store: 'bakery.example', at: `${today}T08:15`, number: '0042', total: 1280, program: JSON.stringify(program) };
    const c = await call(wallet, 'claim_receipt', printed);
    assert.equal(c.status, 'pending');
    assert.equal(c.value, 12);
    const dup = await call(wallet, 'claim_receipt', printed);
    assert.equal(dup.status, 'duplicate');
    assert.deepEqual(((await call(wallet, 'check_claims')).claims as { status: string }[]).map((x) => x.status), ['pending']);

    const listed = (await call(bakery, 'receipts')).claims as { status: string }[];
    assert.deepEqual(listed.map((x) => x.status), ['duplicate', 'pending']);
    const approved = (await call(bakery, 'approve_receipts')).results as { status: string; value: number }[];
    assert.deepEqual(approved.map((x) => [x.status, x.value]), [['issued', 12]]);

    // The café's receipt carries its signed QR: no review, issued at its next sync.
    const qrStore = await openStore(dirs.cafe!);
    const { receiptQr } = await import('../src/receipt.js');
    const qr = receiptQr(program, await qrStore.signReceipt({ at: `${today}T09:00`, number: '7', total: 500 }));
    assert.equal((await call(wallet, 'claim_receipt', { qr })).status, 'authorized');
    assert.deepEqual(((await call(cafe, 'sync_receipts')).results as { value: number }[]).map((x) => x.value), [5]);

    const checked = (await call(wallet, 'check_claims')).claims as { status: string; value: number }[];
    assert.deepEqual(checked.map((x) => [x.status, x.value]).sort(), [['issued', 12], ['issued', 5]].sort());
    const held = await call(wallet, 'list_vouchers');
    assert.equal(held.total, 17);

    // Spent at the café with the key the bakery's voucher is bound to.
    const ch = await call(cafe, 'challenge');
    const bakeryVoucher = (held.vouchers as { issuer: string; digest: string }[]).find((v) => v.issuer === 'bakery.example') as { digest: string };
    const p = await call(wallet, 'present_voucher', { store: ch.store, challenge: ch.challenge, digest: bakeryVoucher.digest });
    const r = await call(cafe, 'redeem_voucher', { presentation: p.presentation });
    assert.equal(r.value, 12);
  } finally {
    await Promise.all([wallet.close(), bakery.close(), cafe.close()]);
    await new Promise<void>((r) => server.close(() => r()));
  }
});
