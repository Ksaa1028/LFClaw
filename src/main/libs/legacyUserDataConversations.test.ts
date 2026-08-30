import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';

import { migrateLegacyUserDataConversations } from './legacyUserDataConversations';

describe('legacy user-data conversation import', () => {
  const directories: string[] = [];
  afterEach(() => directories.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })));

  const databases = (
    legacyCode: string,
    currentCode = legacyCode,
    legacyDisplayName = '测试用户',
    currentDisplayName = legacyDisplayName,
  ) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-legacy-user-data-'));
    directories.push(root);
    const userData = path.join(root, 'LFClaw');
    fs.mkdirSync(userData, { recursive: true });
    const source = new Database(path.join(userData, 'lobsterai.sqlite'));
    source.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, cwd TEXT NOT NULL, agent_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL);
    `);
    source.prepare('INSERT INTO kv VALUES (?, ?, 0)').run('enterprise_activation_identity', JSON.stringify({ activationCode: legacyCode, userId: 'legacy-user', displayName: legacyDisplayName }));
    source.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run('old-session', '升级前对话', 'idle', 'E:\\project', 'main', 1, 2);
    source.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?, ?, ?)').run('old-message', 'old-session', 'assistant', '旧回答', null, 2);
    source.close();

    const target = new Database(path.join(userData, 'lfclaw.sqlite'));
    target.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, cwd TEXT NOT NULL, agent_id TEXT, owner_scope TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL, metadata TEXT, created_at INTEGER NOT NULL);
    `);
    target.prepare('INSERT INTO kv VALUES (?, ?, 0)').run('lfclaw_enterprise_access', JSON.stringify({ activationCode: currentCode, user: { userId: 'current-user', nickname: currentDisplayName } }));
    target.prepare('INSERT INTO cowork_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('new-session', '升级后对话', 'idle', 'E:\\project', 'main', createHash('sha256').update('current-user').digest('hex').slice(0, 16), 3, 4);
    return { target, userData };
  };

  test('merges the renamed database without replacing current conversations', () => {
    const { target, userData } = databases('SAME-CODE');
    try {
      expect(migrateLegacyUserDataConversations(target, userData)).toBe(2);
      expect(target.prepare('SELECT id, title FROM cowork_sessions ORDER BY id').all()).toEqual([
        { id: 'new-session', title: '升级后对话' },
        { id: 'old-session', title: '升级前对话' },
      ]);
      expect(target.prepare('SELECT owner_scope FROM cowork_sessions WHERE id = ?').get('old-session')).toEqual({
        owner_scope: createHash('sha256').update('current-user').digest('hex').slice(0, 16),
      });
      expect(migrateLegacyUserDataConversations(target, userData)).toBe(0);
    } finally {
      target.close();
    }
  });

  test('does not expose another activation code history', () => {
    const { target, userData } = databases('OLD-CODE', 'CURRENT-CODE', '旧用户', '当前用户');
    try {
      expect(migrateLegacyUserDataConversations(target, userData)).toBe(0);
      expect(target.prepare('SELECT id FROM cowork_sessions ORDER BY id').all()).toEqual([{ id: 'new-session' }]);
    } finally {
      target.close();
    }
  });

  test('recovers the same employee after their activation code and user ID were regenerated', () => {
    const { target, userData } = databases('OLD-CODE', 'CURRENT-CODE', '佟凯', ' 佟凯 ');
    try {
      expect(migrateLegacyUserDataConversations(target, userData)).toBe(2);
      expect(target.prepare('SELECT id, title FROM cowork_sessions ORDER BY id').all()).toEqual([
        { id: 'new-session', title: '升级后对话' },
        { id: 'old-session', title: '升级前对话' },
      ]);
    } finally {
      target.close();
    }
  });
});
