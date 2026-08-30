import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { migrateLegacySessionOwnership } from './legacySessionOwnership';

let db: Database.Database;
const scope = createHash('sha256').update('employee-a').digest('hex').slice(0, 16);

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY);
    INSERT INTO cowork_sessions VALUES ('legacy');
    ALTER TABLE cowork_sessions ADD COLUMN owner_scope TEXT NOT NULL DEFAULT '';
  `);
});
afterEach(() => db.close());

function setIdentity(value: string): void {
  db.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?, 0)').run('lfclaw_enterprise_access', value);
}

test('repairs direct upgrades and preserves already-scoped post-upgrade sessions', () => {
  setIdentity(JSON.stringify({ user: { userId: 'employee-a' } }));
  db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('post-upgrade', scope);
  expect(migrateLegacySessionOwnership(db)).toBe(true);
  expect(db.prepare('SELECT * FROM cowork_sessions ORDER BY id').all()).toEqual([
    { id: 'legacy', owner_scope: scope }, { id: 'post-upgrade', owner_scope: scope },
  ]);
  expect(db.prepare('SELECT session_id, original_owner_scope FROM cowork_legacy_session_ownership').all())
    .toEqual([{ session_id: 'legacy', original_owner_scope: '' }]);
  db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('later-local', '');
  expect(migrateLegacySessionOwnership(db)).toBe(false);
  expect(db.prepare('SELECT owner_scope FROM cowork_sessions WHERE id = ?').get('later-local'))
    .toEqual({ owner_scope: '' });
});

test.each([null, JSON.stringify({ user: { userId: '' } })])(
  'finishes a migration deferred before activation: %s', value => {
    if (value !== null) setIdentity(value);
    migrateLegacySessionOwnership(db);
    setIdentity(JSON.stringify({ user: { userId: 'employee-a' } }));
    expect(migrateLegacySessionOwnership(db)).toBe(true);
    expect(db.prepare('SELECT owner_scope FROM cowork_sessions').get()).toEqual({ owner_scope: scope });
  },
);

test('does not claim history after an invalid persisted identity', () => {
  setIdentity('{invalid');
  migrateLegacySessionOwnership(db);
  setIdentity(JSON.stringify({ user: { userId: 'employee-a' } }));
  expect(migrateLegacySessionOwnership(db)).toBe(false);
  expect(db.prepare('SELECT owner_scope FROM cowork_sessions').get()).toEqual({ owner_scope: '' });
});

test('leaves ambiguous multi-employee history unchanged', () => {
  setIdentity(JSON.stringify({ user: { userId: 'employee-a' } }));
  db.prepare('INSERT INTO cowork_sessions VALUES (?, ?)').run('other-employee', 'other-scope');
  const before = db.prepare('SELECT * FROM cowork_sessions').all();
  migrateLegacySessionOwnership(db);
  expect(db.prepare('SELECT * FROM cowork_sessions').all()).toEqual(before);
});

test('rolls back journal, ownership, and completion marker together on failure', () => {
  setIdentity(JSON.stringify({ user: { userId: 'employee-a' } }));
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON cowork_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  expect(() => migrateLegacySessionOwnership(db)).toThrow('test failure');
  expect(db.prepare('SELECT owner_scope FROM cowork_sessions').get()).toEqual({ owner_scope: '' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM kv').get()).toEqual({ n: 1 });
  db.exec('DROP TRIGGER reject_update');
  expect(migrateLegacySessionOwnership(db)).toBe(true);
});
