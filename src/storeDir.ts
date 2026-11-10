import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JWK } from 'jose';
import { parseProgram } from './program.js';
import { JsonlRecorder } from './record.js';
import type { RegistryClientOptions } from './registry.js';
import { Store, type PresentationStore } from './store.js';

/**
 * A store's directory: `store.json` ({id, privateJwk, registry?}),
 * `program.json` (the program as published), `records.jsonl` (what the store
 * did) and `presentations.jsonl` (the vouchers it took, its claim). The
 * directory is `KANGOH_STORE`. `registry` is {url, required?}: the
 * operator's registry to ask before taking a voucher.
 */
export function storeDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.KANGOH_STORE;
  if (!d) throw new Error('KANGOH_STORE must name the store directory');
  return d;
}

/** Presentations appended to a JSON Lines file. */
export class JsonlPresentations implements PresentationStore {
  constructor(readonly path: string) {}

  async put(digest: string, presentation: string): Promise<void> {
    await appendFile(this.path, JSON.stringify({ digest, presentation }) + '\n');
  }

  async all(): Promise<{ [digest: string]: string }> {
    const out: { [digest: string]: string } = {};
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw e;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const { digest, presentation } = JSON.parse(line) as { digest: string; presentation: string };
      out[digest] = presentation;
    }
    return out;
  }
}

/** Opens a store from its directory, recording the program first if nothing is recorded yet. */
export async function openStore(dir: string, now?: () => Date): Promise<Store> {
  const { id, privateJwk, registry } = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8')) as { id: string; privateJwk: JWK; registry?: RegistryClientOptions };
  if (!id || !privateJwk) throw new Error(`${dir}/store.json needs id and privateJwk`);
  const programJson = await readFile(join(dir, 'program.json'), 'utf8');
  const program = parseProgram(programJson);
  const recorder = new JsonlRecorder(join(dir, 'records.jsonl'));
  const store = new Store({
    id,
    privateJwk,
    program,
    programJson,
    recorder,
    presentations: new JsonlPresentations(join(dir, 'presentations.jsonl')),
    ...(registry ? { registry } : {}),
    ...(now ? { now } : {}),
  });
  if ((await recorder.records()).length === 0) await store.join();
  return store;
}
