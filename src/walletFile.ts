import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateKey, type KeyPair } from './keys.js';

/** What the agent keeps on disk: its key and its vouchers. Nothing else. */
export interface WalletFile {
  key: KeyPair;
  vouchers: string[];
}

/** The wallet file: `KANGOH_WALLET`, or `~/.kangoh/wallet.json`. */
export function walletPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.KANGOH_WALLET ?? join(homedir(), '.kangoh', 'wallet.json');
}

/** Reads the wallet file, creating it with a fresh key if it does not exist. */
export async function openWalletFile(path: string): Promise<WalletFile> {
  try {
    const w = JSON.parse(await readFile(path, 'utf8')) as WalletFile;
    if (!w.key?.privateJwk || !Array.isArray(w.vouchers)) throw new Error(`${path}: not a wallet file`);
    return w;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const w: WalletFile = { key: await generateKey(), vouchers: [] };
  await saveWalletFile(path, w);
  return w;
}

/** Writes the wallet file, readable by its owner only. */
export async function saveWalletFile(path: string, w: WalletFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(w, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
