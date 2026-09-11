import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createEnterpriseDataStore, pruneEnterpriseData } from './dataStore.mjs';

test('serializes saves and leaves a valid latest JSON document', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-enterprise-data-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'enterprise-data.json');
  const store = createEnterpriseDataStore({
    filePath,
    normalize: value => value,
    createDefault: () => ({ values: [], sessions: {}, usageEvents: [] }),
    retention: { sessionTtlMs: Number.MAX_SAFE_INTEGER, usageRetentionMs: Number.MAX_SAFE_INTEGER, usageMaxEvents: 100 },
  });
  const data = store.load();
  data.values.push('first');
  const firstSave = store.save();
  data.values.push('second');
  const secondSave = store.save();
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')).values, ['first', 'second']);
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('refuses to replace corrupt enterprise data with defaults', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-enterprise-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'enterprise-data.json');
  fs.writeFileSync(filePath, '{broken', 'utf8');
  const store = createEnterpriseDataStore({
    filePath,
    normalize: value => value,
    createDefault: () => ({}),
  });
  assert.throws(() => store.load(), SyntaxError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});

test('prunes expired sessions and bounds retained usage events', () => {
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  const data = {
    sessions: {
      expired: { createdAt: '2026-07-01T00:00:00.000Z' },
      active: { lastSeenAt: '2026-08-31T00:00:00.000Z' },
    },
    usageEvents: [
      { id: 'old', createdAt: '2026-07-01T00:00:00.000Z' },
      { id: 'one', createdAt: '2026-08-29T00:00:00.000Z' },
      { id: 'two', createdAt: '2026-08-30T00:00:00.000Z' },
    ],
  };
  pruneEnterpriseData(data, { sessionTtlMs: 30 * 86400000, usageRetentionMs: 30 * 86400000, usageMaxEvents: 1 }, now);
  assert.deepEqual(Object.keys(data.sessions), ['active']);
  assert.deepEqual(data.usageEvents.map(event => event.id), ['two']);
});
