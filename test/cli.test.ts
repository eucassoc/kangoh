import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, ['dist/src/cli.js', ...args]);

test('keygen writes the private key readable by its owner only, redirected or with -o', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kangoh-key-'));
  // As `kangoh keygen > bakery.json` would: the shell creates the file for everyone to read.
  const redirected = join(dir, 'bakery.json');
  const fd = openSync(redirected, 'w', 0o644);
  spawnSync(process.execPath, ['dist/src/cli.js', 'keygen'], { stdio: ['ignore', fd, 'inherit'] });
  closeSync(fd);
  assert.equal(statSync(redirected).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(redirected, 'utf8')).d);
  const out = join(dir, 'cafe.json');
  await cli('keygen', '-o', out);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  await assert.rejects(cli('keygen', '-o', out), /EEXIST|exists/);
});
