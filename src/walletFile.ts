import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { generateKey, type KeyPair } from './keys.js';

/** What the agent keeps on disk: its keys, its vouchers and the receipt claims it is waiting on. Nothing else. */
export interface WalletFile {
  /** The receiving key a store issues to at the counter. */
  key: KeyPair;
  vouchers: string[];
  /** A fresh key per receipt claim, so that no two claims can be linked. */
  keys?: KeyPair[];
  /** Receipt claims waiting for the store. */
  pending?: PendingClaim[];
  /** Change due for vouchers used in part, until it is in the wallet. */
  changes?: PendingChange[];
}

export interface PendingChange {
  /** Digest of the voucher used in part. */
  parent: string;
  /** kid of the key the change is bound to. */
  kid: string;
  /** The operator's service, where missed change can be fetched. */
  service?: string;
}

export interface PendingClaim {
  id: string;
  /** The operator's service the claim was made at. */
  service: string;
  store: string;
  /** The receipt as claimed, so the customer can tell claims apart. */
  receipt: { at: string; number: string; total: number };
  value: number;
  submitted: string;
  /** kid of the key the voucher will be bound to. */
  kid: string;
}

/** The key a voucher is bound to, among the wallet's keys. */
export function keyFor(w: WalletFile, x: string | undefined): KeyPair | undefined {
  return [w.key, ...(w.keys ?? [])].find((k) => k.publicJwk.x === x);
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
