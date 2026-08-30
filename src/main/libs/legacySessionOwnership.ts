import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

const ACCESS_KEY = 'lfclaw_enterprise_access';
const MIGRATION_KEY = 'cowork.legacySessionOwnership.v1';

/** Repair pre-owner_scope history, including databases already upgraded on Aug 21.
 * Only use the persisted identity at startup, never a newly activated account or
 * an environment override. Keep a reversible ownership journal in the same
 * transaction; conversation data and runtime session IDs are never rewritten.
 */
export function migrateLegacySessionOwnership(db: Database.Database): boolean {
  // Freeze an unresolved decision too: a different employee logging in later
  // must not automatically claim malformed or multi-owner history.
  const defer = (reason: string): boolean => {
    db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(MIGRATION_KEY, JSON.stringify({ ownerScope: null, reason }), Date.now());
    console.warn(`[SqliteStore] Legacy session ownership requires review: ${reason}`);
    return true;
  };

  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(ACCESS_KEY) as
    { value: string } | undefined;
  let userId: string | undefined;
  try {
    const access = row ? JSON.parse(row.value) : null;
    userId = typeof access?.user?.userId === 'string' ? access.user.userId.trim() : undefined;
  } catch {
    return defer('invalid persisted identity');
  }
  if (!userId) return defer('missing persisted identity');
  const marker = db.prepare('SELECT value FROM kv WHERE key = ?').get(MIGRATION_KEY) as
    { value: string } | undefined;
  if (marker) {
    try {
      const state = JSON.parse(marker.value) as { ownerScope?: string | null; reason?: string };
      // Startup may initialize SQLite before the user activates. Once an
      // identity is persisted, finish that deferred migration instead of
      // permanently hiding every ownerless conversation.
      if (state.ownerScope !== null || state.reason !== 'missing persisted identity') return false;
    } catch {
      return false;
    }
  }
  const ownerScope = createHash('sha256').update(userId).digest('hex').slice(0, 16);
  const hasOtherOwner = db.prepare(
    "SELECT 1 FROM cowork_sessions WHERE owner_scope <> '' AND owner_scope <> ? LIMIT 1",
  ).get(ownerScope);
  if (hasOtherOwner) {
    return defer('multiple employee identities');
  }

  const migrated = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cowork_legacy_session_ownership (
        session_id TEXT PRIMARY KEY,
        original_owner_scope TEXT NOT NULL,
        assigned_owner_scope TEXT NOT NULL,
        migrated_at INTEGER NOT NULL
      );
    `);
    const now = Date.now();
    db.prepare(`
      INSERT INTO cowork_legacy_session_ownership
        (session_id, original_owner_scope, assigned_owner_scope, migrated_at)
      SELECT id, owner_scope, ?, ? FROM cowork_sessions WHERE owner_scope = ''
    `).run(ownerScope, now);
    const result = db.prepare(
      "UPDATE cowork_sessions SET owner_scope = ? WHERE owner_scope = ''",
    ).run(ownerScope);
    db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
      .run(MIGRATION_KEY, JSON.stringify({ ownerScope, count: result.changes }), now);
    return result.changes;
  })();
  console.log(`[SqliteStore] Legacy session ownership migration completed: ${migrated} sessions`);
  return true;
}
