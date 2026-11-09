import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from '../src/version.js';

test('the version collectors record is the package version', () => {
  assert.equal(VERSION, (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version);
});
