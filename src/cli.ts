#!/usr/bin/env node
// kangoh: reward vouchers as verifiable credentials.
//
//   kangoh keygen                                   a key pair, as JSON
//   kangoh issue -p program.json -k store.json -h holder.json [--days N]
//   kangoh present -k holder.json --aud STORE --nonce N [voucher]
//   kangoh verify -p program.json --aud STORE [--nonce N] [presentation]
//   kangoh settle -p program.json claim.json...
//   kangoh registry [--port 8788] [--file claims.jsonl] [--token SECRET]
//
// Documents are read from a file argument or standard input and written to
// standard output, so that the commands compose with whatever a store or an
// agent already runs.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { generateKey, toPublic } from './keys.js';
import { parseProgram } from './program.js';
import { present, verifyPresentation } from './presentation.js';
import { formatFinding, settle } from './settlement.js';
import type { Claim } from './store.js';
import { issueVoucher } from './voucher.js';
import { Registry, registryServer } from './registry.js';

async function read(path: string | undefined): Promise<string> {
  const buf = path && path !== '-' ? await readFile(path) : await readStdin();
  return buf.toString('utf8');
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'keygen': {
      const k = await generateKey();
      console.log(JSON.stringify(k.privateJwk));
      return 0;
    }
    case 'issue': {
      const { values } = parseArgs({
        args: rest,
        options: { program: { type: 'string', short: 'p' }, key: { type: 'string', short: 'k' }, holder: { type: 'string', short: 'h' }, id: { type: 'string' } },
      });
      const program = parseProgram(await read(need(values.program, '--program')));
      const key = JSON.parse(await read(need(values.key, '--key')));
      const holder = JSON.parse(await read(need(values.holder, '--holder')));
      const id = values.id ?? program.stores.find((m) => m.key.x === key.x)?.id;
      if (!id) throw new Error('the key is not in the program; give the store with --id');
      console.log(await issueVoucher(program, { id, privateJwk: key }, toPublic(holder)));
      return 0;
    }
    case 'present': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { key: { type: 'string', short: 'k' }, aud: { type: 'string' }, nonce: { type: 'string' } },
      });
      const key = JSON.parse(await read(need(values.key, '--key')));
      const voucher = (await read(positionals[0])).trim();
      console.log(await present(voucher, key, need(values.aud, '--aud'), need(values.nonce, '--nonce')));
      return 0;
    }
    case 'verify': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { program: { type: 'string', short: 'p' }, aud: { type: 'string' }, nonce: { type: 'string' } },
      });
      const program = parseProgram(await read(need(values.program, '--program')));
      const presentation = (await read(positionals[0])).trim();
      const p = await verifyPresentation(program, presentation, { aud: need(values.aud, '--aud'), ...(values.nonce ? { nonce: values.nonce } : {}), at: new Date() });
      console.log(JSON.stringify({ issuer: p.claims.iss, value: p.claims.value, expires: new Date(p.claims.exp * 1000).toISOString(), nonce: p.kb.nonce }));
      return 0;
    }
    case 'settle': {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { program: { type: 'string', short: 'p' } },
      });
      const programJson = await read(need(values.program, '--program'));
      const program = parseProgram(programJson);
      const claims: Claim[] = [];
      for (const path of positionals) claims.push(JSON.parse(await read(path)) as Claim);
      const { findings, statements } = await settle(program, programJson, claims);
      for (const f of findings) console.log(formatFinding(f));
      console.log(JSON.stringify(statements, null, 2));
      return findings.length ? 1 : 0;
    }
    case 'registry': {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: 'string', default: '8788' }, file: { type: 'string', default: 'claims.jsonl' }, token: { type: 'string' } },
      });
      const registry = new Registry(values.file);
      await registry.load();
      const server = registryServer({ registry, ...(values.token ? { token: values.token } : {}) });
      await new Promise<void>((resolve) => server.listen(Number(values.port), resolve));
      console.error(`registry on port ${values.port}, ${registry.size} claims in ${values.file}`);
      await new Promise(() => {});
      return 0;
    }
    default:
      console.error('usage: kangoh keygen | issue | present | verify | settle | registry');
      return 2;
  }
}

function need(v: string | undefined, flag: string): string {
  if (!v) throw new Error(`${flag} is required`);
  return v;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    console.error(e.message);
    process.exit(1);
  },
);
