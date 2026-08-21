import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseHistoryEntry, normalizeReleaseHistory } from './releaseHistory.mjs';

test('creates a release history entry with server time', () => {
  const entry = createReleaseHistoryEntry({ version: ' 2026080903 ', description: ' 修复客户端启动稳定性 ' }, '2026-08-21T08:00:00.000Z');
  assert.match(entry.id, /^release-/);
  assert.equal(entry.version, '2026080903');
  assert.equal(entry.description, '修复客户端启动稳定性');
  assert.equal(entry.createdAt, '2026-08-21T08:00:00.000Z');
});

test('requires version and description', () => {
  assert.throws(() => createReleaseHistoryEntry({ description: '内容' }), /版本号必填/);
  assert.throws(() => createReleaseHistoryEntry({ version: '1' }), /更新描述必填/);
});

test('drops invalid persisted entries', () => {
  assert.deepEqual(normalizeReleaseHistory([
    { id: 'release-1', version: '1', description: '内容', createdAt: '2026-08-21T08:00:00.000Z' },
    { id: '', version: '2', description: '无效', createdAt: '2026-08-21T08:00:00.000Z' },
  ]), [{ id: 'release-1', version: '1', description: '内容', createdAt: '2026-08-21T08:00:00.000Z' }]);
});
