import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/** A dedicated snapshot is never rotated by the periodic backup job. */
export async function backupBeforeAppUpdate(db: Database.Database, userData: string): Promise<string> {
  const directory = path.join(userData, 'backups', 'before-update');
  await fs.promises.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${Date.now()}-${process.pid}.sqlite`);
  await db.backup(target);
  const { default: Sqlite } = await import('better-sqlite3');
  const snapshot = new Sqlite(target, { readonly: true, fileMustExist: true });
  try {
    if (snapshot.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Pre-update database backup failed verification');
  } finally {
    snapshot.close();
  }
  return target;
}
