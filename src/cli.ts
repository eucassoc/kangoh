#!/usr/bin/env node
// kangoh: reward vouchers as verifiable credentials.
//
//   kangoh keygen                                   a key pair, as JSON
//   kangoh issue -p program.json -k store.json -h holder.json [--value N]
//   kangoh present -k holder.json --aud STORE --nonce N [voucher]
//   kangoh verify -p program.json --aud STORE [--nonce N] [presentation]
//   kangoh settle -p program.json claim.json...
//   kangoh registry [--port 8788] [--file claims.jsonl] [--token SECRET]
//                   [--program program.json [--key operator.json] [--state receipts.jsonl] [--chain receipts.chain.jsonl]]
//                                                   the operator's service; with a program that earns
//                                                   from receipts, also the receipt desk (HMAC key in
//                                                   KANGOH_DESK_SECRET), and
//                                                   with the operator's key, change for vouchers used in part
//   kangoh receipt-qr -p program.json -k store.json --number N --total T [--at TIME] [--value V]
//                                                   what a point of sale prints on a receipt
//   kangoh receipts [list] [--from DATE]            a store's receipt claims (KANGOH_STORE)
//   kangoh receipts approve [ID...] [--total ID=T]  approve claims; all waiting ones without IDs
//   kangoh receipts reject ID --reason TEXT
//   kangoh receipts sync                            issue the claims made with the store's signed QR
//
// Documents are read from a file argument or standard input and written to
// standard output, so that the commands compose with whatever a store or an
// agent already runs.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { generateKey, toPublic } from './keys.js';
import { parseProgram, type Program } from './program.js';
import { present, verifyPresentation } from './presentation.js';
import { formatFinding, settle } from './settlement.js';
import type { Claim } from './store.js';
import { issueVoucher } from './voucher.js';
import { Registry, registryServer } from './registry.js';
import { ReceiptDesk } from './desk.js';
import { approveReceipts, DeskClient, rejectReceipt, storeClaims, syncReceipts, type Answered } from './deskClient.js';
import { receiptQr, signReceipt } from './receipt.js';
import { openStore, storeDir } from './storeDir.js';

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
        options: { program: { type: 'string', short: 'p' }, key: { type: 'string', short: 'k' }, holder: { type: 'string', short: 'h' }, id: { type: 'string' }, value: { type: 'string' } },
      });
      const program = parseProgram(await read(need(values.program, '--program')));
      const key = JSON.parse(await read(need(values.key, '--key')));
      const holder = JSON.parse(await read(need(values.holder, '--holder')));
      const id = values.id ?? program.stores.find((m) => m.key.x === key.x)?.id;
      if (!id) throw new Error('the key is not in the program; give the store with --id');
      console.log(await issueVoucher(program, { id, privateJwk: key }, toPublic(holder), new Date(), values.value ? Number(values.value) : program.value));
      return 0;
    }
    case 'receipt-qr': {
      const { values } = parseArgs({
        args: rest,
        options: {
          program: { type: 'string', short: 'p' },
          key: { type: 'string', short: 'k' },
          id: { type: 'string' },
          number: { type: 'string' },
          total: { type: 'string' },
          at: { type: 'string' },
          value: { type: 'string' },
        },
      });
      const program = parseProgram(await read(need(values.program, '--program')));
      const key = JSON.parse(await read(need(values.key, '--key')));
      const id = values.id ?? program.stores.find((m) => m.key.x === key.x)?.id;
      if (!id) throw new Error('the key is not in the program; give the store with --id');
      const token = await signReceipt(
        program,
        { id, privateJwk: key },
        { at: values.at ?? localMinute(new Date()), number: need(values.number, '--number'), total: Number(need(values.total, '--total')) },
        values.value ? { value: Number(values.value) } : {},
      );
      console.log(receiptQr(program, token));
      return 0;
    }
    case 'receipts': {
      const [sub = 'list', ...args] = rest;
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { from: { type: 'string' }, total: { type: 'string', multiple: true }, reason: { type: 'string' } },
      });
      const store = await openStore(storeDir());
      const service = store.programOf.service;
      if (!service) throw new Error("the program names no service: receipt claims need the operator's service");
      const client = new DeskClient(service);
      const from = values.from;
      switch (sub) {
        case 'list': {
          const claims = await storeClaims(store, client, from);
          for (const c of claims) {
            const mark = c.status === 'duplicate' ? 'ERROR ' : '';
            console.log([c.id, `${mark}${c.status}`, c.receipt.at, c.receipt.number, c.receipt.total, `${c.value}pt`, c.signed ? 'QR' : '', c.reason ?? ''].join('\t'));
          }
          const waiting = claims.filter((c) => c.status === 'pending').length;
          console.error(`${claims.length} claims, ${waiting} waiting for review`);
          return 0;
        }
        case 'approve': {
          const totals: { [id: string]: number } = {};
          for (const t of values.total ?? []) {
            const [id, v] = t.split('=');
            if (!id || !v) throw new Error('--total is ID=TOTAL');
            totals[id] = Number(v);
          }
          return report(await approveReceipts(store, client, { ...(positionals.length ? { ids: positionals } : {}), totals, ...(from ? { from } : {}) }));
        }
        case 'reject':
          return report([await rejectReceipt(store, client, need(positionals[0], 'the claim id'), need(values.reason, '--reason'))]);
        case 'sync':
          return report(await syncReceipts(store, client, from));
        default:
          throw new Error(`unknown receipts command ${sub}; use list, approve, reject or sync`);
      }
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
        options: {
          port: { type: 'string', default: '8788' },
          file: { type: 'string', default: 'claims.jsonl' },
          token: { type: 'string' },
          program: { type: 'string' },
          key: { type: 'string' },
          state: { type: 'string', default: 'receipts.jsonl' },
          chain: { type: 'string', default: 'receipts.chain.jsonl' },
        },
      });
      const program = values.program ? parseProgram(await read(values.program)) : undefined;
      if (values.key && !program) throw new Error('--key needs --program: change is issued under a program');
      const key = values.key ? JSON.parse(await read(values.key)) : undefined;
      if (key && program?.operator?.key.x !== key.x) throw new Error("the key is not the operator's key in the program");
      const registry = new Registry(values.file, undefined, program && key ? { program, key } : undefined);
      await registry.load();
      let desk: ReceiptDesk | undefined;
      if (program?.earn) {
        const secret = process.env.KANGOH_DESK_SECRET;
        if (!secret) throw new Error('KANGOH_DESK_SECRET must hold the key the public chain hashes receipts with');
        desk = new ReceiptDesk({ program: program as Program, secret, state: values.state, chain: values.chain });
        await desk.load();
      }
      const server = registryServer({ registry, ...(values.token ? { token: values.token } : {}), ...(desk ? { desk } : {}) });
      await new Promise<void>((resolve) => server.listen(Number(values.port), resolve));
      console.error(`registry on port ${values.port}, ${registry.size} claims in ${values.file}`);
      if (key) console.error('issuing change with the operator key');
      if (desk) console.error(`receipt desk: ${desk.size} receipt claims in ${values.state}, outcomes chained in ${values.chain}`);
      await new Promise(() => {});
      return 0;
    }
    default:
      console.error('usage: kangoh keygen | issue | present | verify | settle | registry | receipt-qr | receipts');
      return 2;
  }
}

/** Prints the answers to claims; exits 1 if any failed. */
function report(results: Answered[]): number {
  for (const r of results) console.log([r.id, r.error ? `ERROR ${r.error}` : r.status, r.value !== undefined ? `${r.value}pt` : '', r.reason ?? ''].join('\t'));
  return results.some((r) => r.error) ? 1 : 0;
}

/** Local time to the minute, as receipts print it. */
function localMinute(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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
