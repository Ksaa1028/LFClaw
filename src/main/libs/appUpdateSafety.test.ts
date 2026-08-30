import Sqlite from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { backupBeforeAppUpdate } from './appUpdateSafety';

describe('pre-update database backup', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => (
      fs.promises.rm(directory, { recursive: true, force: true })
    )));
  });

  test('creates a verified snapshot without modifying the live database', async () => {
    const userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-update-backup-'));
    temporaryDirectories.push(userData);
    const databasePath = path.join(userData, 'lobsterai.sqlite');
    const db = new Sqlite(databasePath);
    try {
      db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
      db.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run('session-1', '升级前对话');

      const snapshotPath = await backupBeforeAppUpdate(db, userData);
      expect(snapshotPath).toContain(path.join('backups', 'before-update'));
      expect(fs.existsSync(snapshotPath)).toBe(true);

      const snapshot = new Sqlite(snapshotPath, { readonly: true, fileMustExist: true });
      try {
        expect(snapshot.pragma('quick_check', { simple: true })).toBe('ok');
        expect(snapshot.prepare('SELECT title FROM conversations WHERE id = ?').get('session-1')).toEqual({ title: '升级前对话' });
      } finally {
        snapshot.close();
      }

      expect(db.prepare('SELECT COUNT(*) AS count FROM conversations').get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});
