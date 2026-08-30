import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const CURRENT_ACCESS_KEY = 'lfclaw_enterprise_access';
const LEGACY_IDENTITY_KEY = 'enterprise_activation_identity';
const LEGACY_DATABASE_FILENAMES = ['lobsterai.sqlite', 'lfclaw.sqlite'] as const;
const COPY_TABLES = ['agents', 'cowork_sessions', 'cowork_messages', 'cowork_session_capsules'] as const;

interface StoredIdentity {
  activationCode: string;
  userId: string;
  displayName: string;
}

const readJsonKey = (db: Database.Database, key: string): Record<string, unknown> | null => {
  try {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: string } | undefined;
    const parsed = row?.value ? JSON.parse(row.value) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const identityFromCurrentDatabase = (db: Database.Database): StoredIdentity | null => {
  const access = readJsonKey(db, CURRENT_ACCESS_KEY);
  const user = access?.user && typeof access.user === 'object' && !Array.isArray(access.user)
    ? access.user as Record<string, unknown>
    : null;
  const userId = typeof user?.userId === 'string' ? user.userId.trim() : '';
  const activationCode = typeof access?.activationCode === 'string' ? access.activationCode.trim().toUpperCase() : '';
  const displayName = typeof user?.nickname === 'string' ? user.nickname.trim() : '';
  return userId && activationCode ? { userId, activationCode, displayName } : null;
};

const identityFromLegacyDatabase = (db: Database.Database): Pick<StoredIdentity, 'activationCode' | 'displayName'> => {
  const legacy = readJsonKey(db, LEGACY_IDENTITY_KEY);
  if (typeof legacy?.activationCode === 'string') {
    return {
      activationCode: legacy.activationCode.trim().toUpperCase(),
      displayName: typeof legacy.displayName === 'string' ? legacy.displayName.trim() : '',
    };
  }
  const current = readJsonKey(db, CURRENT_ACCESS_KEY);
  const user = current?.user && typeof current.user === 'object' && !Array.isArray(current.user)
    ? current.user as Record<string, unknown>
    : null;
  return {
    activationCode: typeof current?.activationCode === 'string' ? current.activationCode.trim().toUpperCase() : '',
    displayName: typeof user?.nickname === 'string' ? user.nickname.trim() : '',
  };
};

const normalizedDisplayName = (value: string): string => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();

const tableExists = (db: Database.Database, table: string): boolean => Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
).get(table));

const tableColumns = (db: Database.Database, table: string): string[] => (
  db.pragma(`table_info(${table})`) as Array<{ name: string }>
).map(column => column.name);

const quoted = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function copyCompatibleRows(
  target: Database.Database,
  source: Database.Database,
  table: typeof COPY_TABLES[number],
  ownerScope: string,
): number {
  if (!tableExists(source, table) || !tableExists(target, table)) return 0;
  const targetColumns = new Set(tableColumns(target, table));
  const columns = tableColumns(source, table).filter(column => targetColumns.has(column) && column !== 'owner_scope');
  if (!columns.length) return 0;
  const insertedColumns = table === 'cowork_sessions' && targetColumns.has('owner_scope')
    ? [...columns, 'owner_scope']
    : columns;
  const statement = target.prepare(`INSERT OR IGNORE INTO ${quoted(table)} (${insertedColumns.map(quoted).join(', ')}) VALUES (${insertedColumns.map(() => '?').join(', ')})`);
  let changes = 0;
  for (const row of source.prepare(`SELECT ${columns.map(quoted).join(', ')} FROM ${quoted(table)}`).iterate() as Iterable<Record<string, unknown>>) {
    const values = columns.map(column => row[column]);
    if (insertedColumns.length !== columns.length) values.push(ownerScope);
    changes += statement.run(...values).changes;
  }
  return changes;
}

const legacyDatabaseCandidates = (userDataPath: string): string[] => {
  const parent = path.dirname(userDataPath);
  return [
    path.join(userDataPath, LEGACY_DATABASE_FILENAMES[0]),
    ...LEGACY_DATABASE_FILENAMES.map(filename => path.join(parent, 'LobsterAI', filename)),
  ];
};

/** Merge conversations left behind by the LobsterAI -> LFClaw data-directory
 * and database rename. Existing LFClaw rows win; matching activation codes
 * safely bridge historical and current employee IDs.
 */
export function migrateLegacyUserDataConversations(
  target: Database.Database,
  userDataPath: string,
): number {
  const identity = identityFromCurrentDatabase(target);
  if (!identity) return 0;
  const ownerScope = createHash('sha256').update(identity.userId).digest('hex').slice(0, 16);
  const targetPath = path.resolve(path.join(userDataPath, 'lfclaw.sqlite')).toLowerCase();
  const seen = new Set<string>();
  let imported = 0;

  for (const candidate of legacyDatabaseCandidates(userDataPath)) {
    const normalized = path.resolve(candidate).toLowerCase();
    if (normalized === targetPath || seen.has(normalized) || !fs.existsSync(candidate)) continue;
    seen.add(normalized);
    const stat = fs.statSync(candidate);
    const markerKey = `cowork.legacyUserDataImport.v1.${createHash('sha256')
      .update(`${normalized}\0${stat.size}\0${Math.trunc(stat.mtimeMs)}\0${identity.activationCode}`)
      .digest('hex').slice(0, 16)}`;
    if (target.prepare('SELECT 1 FROM kv WHERE key = ?').get(markerKey)) continue;

    let source: Database.Database | null = null;
    try {
      source = new Database(candidate, { readonly: true, fileMustExist: true });
      if (source.pragma('quick_check', { simple: true }) !== 'ok') {
        console.warn(`[SqliteStore] Skipped unhealthy legacy database: ${candidate}`);
        continue;
      }
      const legacyIdentity = identityFromLegacyDatabase(source);
      const activationMatches = Boolean(legacyIdentity.activationCode)
        && legacyIdentity.activationCode === identity.activationCode;
      const displayNameMatches = Boolean(legacyIdentity.displayName && identity.displayName)
        && normalizedDisplayName(legacyIdentity.displayName) === normalizedDisplayName(identity.displayName);
      if (legacyIdentity.activationCode && !activationMatches && !displayNameMatches) {
        console.warn(`[SqliteStore] Deferred legacy database for another activation: ${candidate}`);
        continue;
      }
      let sourceImported = 0;
      target.transaction(() => {
        for (const table of COPY_TABLES) {
          sourceImported += copyCompatibleRows(target, source!, table, ownerScope);
        }
        target.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
          markerKey,
          JSON.stringify({ source: candidate, imported: sourceImported, ownerScope }),
          Date.now(),
        );
      })();
      imported += sourceImported;
      console.log(`[SqliteStore] Imported ${sourceImported} legacy conversation rows from ${candidate}`);
    } catch (error) {
      console.error(`[SqliteStore] Failed to import legacy conversations from ${candidate}:`, error);
    } finally {
      source?.close();
    }
  }
  return imported;
}
