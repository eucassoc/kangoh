import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JsonlRecorder, parseRecords } from '../src/record.js';

test('records go to a JSON Lines file in sequence, and are read back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wariff-'));
  const path = join(dir, 'records.jsonl');
  const r = new JsonlRecorder(path);
  assert.deepEqual(await r.records(), []);
  await r.append({ at: '2026-04-01T09:00:00.000Z', event: 'program', digest: 'a' });
  await r.append({ at: '2026-04-01T09:01:00.000Z', event: 'issued', digest: 'b' });
  const again = new JsonlRecorder(path);
  const third = await again.append({ at: '2026-04-01T09:02:00.000Z', event: 'redeemed', digest: 'c', meta: { voucher: 'b', issuer: 'x' } });
  assert.equal(third.seq, 2);
  assert.equal((await r.records()).length, 3);
  assert.throws(() => parseRecords('{"seq":1}\n'), /seq is 1/);
});
