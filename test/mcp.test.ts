import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JWK } from 'jose';
import type { Store } from '../src/store.js';
import type { WalletFile } from '../src/walletFile.js';
import { fixture } from './program.test.js';

test('an agent holds, presents and removes vouchers through the MCP server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kangoh-'));
  const path = join(dir, 'wallet.json');
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/src/mcp.js'], env: { ...process.env, KANGOH_WALLET: path } }));
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['add_voucher', 'list_vouchers', 'present_voucher', 'receiving_key', 'remove_voucher']);

    const f = await fixture(undefined, { start: new Date() }); // real time: the server uses the real clock
    const [bakery, cafe] = f.stores as [Store, Store];
    const key = (await call(client, 'receiving_key', {})).jwk as JWK;
    assert.equal(key.kty, 'OKP');
    assert.equal((JSON.parse(await readFile(path, 'utf8')) as WalletFile).key.publicJwk.x, key.x);

    const voucher = await bakery.issue(key);
    const added = await call(client, 'add_voucher', { voucher, program: f.programJson });
    assert.equal(added.issuer, 'bakery.example');
    await call(client, 'add_voucher', { voucher }); // again, without a program: not duplicated
    const listed = await call(client, 'list_vouchers', {});
    assert.equal((listed.vouchers as unknown[]).length, 1);
    assert.equal(listed.total, 100);

    const challenge = cafe.challenge();
    const p = await call(client, 'present_voucher', { store: 'cafe.example', challenge });
    const r = await cafe.redeem(p.presentation as string);
    assert.equal(r.voucherDigest, added.digest);
    await call(client, 'remove_voucher', { digest: added.digest });
    assert.equal((await call(client, 'list_vouchers', {})).total, 0);

    // A voucher bound to another key is refused when a program is given.
    const other = await bakery.issue((await import('../src/keys.js').then((m) => m.generateKey())).publicJwk);
    await assert.rejects(call(client, 'add_voucher', { voucher: other, program: f.programJson }), /another key/);
    await assert.rejects(call(client, 'present_voucher', { store: 'cafe.example', challenge: 'x' }), /no valid voucher/);
  } finally {
    await client.close();
  }
});

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) {
    const c = r.content as { text?: string }[];
    throw new Error(c[0]?.text ?? 'tool error');
  }
  return r.structuredContent as Record<string, unknown>;
}

test('the MCP server starts through a symlink, as npm installs a bin', async () => {
  const { symlink, mkdtemp: mk } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const dir = await mk(join(tmpdir(), 'kangoh-bin-'));
  const link = join(dir, 'kangoh-mcp');
  await symlink(resolve('dist/src/mcp.js'), link);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [link], env: { ...(process.env as Record<string, string>), KANGOH_WALLET: join(dir, 'wallet.json') } }));
  try {
    assert.ok((await client.listTools()).tools.length > 0);
  } finally {
    await client.close();
  }
});
