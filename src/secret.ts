import { fchmodSync, fstatSync, writeFileSync } from 'node:fs';

/**
 * Writes a private key: to `out`, created readable by its owner only and
 * never over an existing file, or to standard output. When standard output
 * is redirected to a file (`keygen > key.json`), the shell has created it
 * readable by everyone (umask 022); it is narrowed to the owner first.
 */
export function writeSecret(text: string, out?: string): void {
  if (out) {
    writeFileSync(out, text + '\n', { mode: 0o600, flag: 'wx' });
    return;
  }
  try {
    if (fstatSync(1).isFile()) fchmodSync(1, 0o600);
  } catch {
    // Not a file we can change, such as a pipe or a terminal.
  }
  process.stdout.write(text + '\n');
}
