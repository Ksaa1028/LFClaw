import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createReleaseHashCache } from './releaseCatalog.mjs';

test('caches hashes by file size and modification time', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-release-hash-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'release.exe');
  fs.writeFileSync(filePath, 'first');
  const cache = createReleaseHashCache();
  const stat = fs.statSync(filePath);
  const [first, concurrent] = await Promise.all([cache.hashFile(filePath, stat), cache.hashFile(filePath, stat)]);
  assert.equal(first, concurrent);
  fs.writeFileSync(filePath, 'second-version');
  const second = await cache.hashFile(filePath, fs.statSync(filePath));
  assert.notEqual(first, second);
});
