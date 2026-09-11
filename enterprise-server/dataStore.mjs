import fs from 'fs';
import path from 'path';

const DAY_MS = 24 * 60 * 60 * 1000;

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const dataRetentionFromEnv = (env = process.env) => ({
  sessionTtlMs: positiveNumber(env.LFCLAW_ENTERPRISE_SESSION_TTL_DAYS, 30) * DAY_MS,
  usageRetentionMs: positiveNumber(env.LFCLAW_ENTERPRISE_USAGE_RETENTION_DAYS, 180) * DAY_MS,
  usageMaxEvents: Math.floor(positiveNumber(env.LFCLAW_ENTERPRISE_USAGE_MAX_EVENTS, 100_000)),
});

export const pruneEnterpriseData = (data, options = dataRetentionFromEnv(), now = Date.now()) => {
  const sessions = data.sessions && typeof data.sessions === 'object' ? data.sessions : {};
  for (const [token, session] of Object.entries(sessions)) {
    const seenAt = Date.parse(session?.lastSeenAt || session?.createdAt || '');
    if (!Number.isFinite(seenAt) || now - seenAt > options.sessionTtlMs) delete sessions[token];
  }
  data.sessions = sessions;

  const cutoff = now - options.usageRetentionMs;
  const retained = (Array.isArray(data.usageEvents) ? data.usageEvents : [])
    .filter(event => {
      const createdAt = Date.parse(event?.createdAt || '');
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    });
  data.usageEvents = retained.slice(-options.usageMaxEvents);
  return data;
};

export const createEnterpriseDataStore = ({ filePath, normalize, createDefault, retention }) => {
  let data;
  let saveQueue = Promise.resolve();
  let lastSaveError = null;
  let lastSavedAt = '';

  const load = () => {
    if (!fs.existsSync(filePath)) {
      data = normalize(createDefault());
      return data;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    data = normalize(JSON.parse(raw));
    return data;
  };

  const get = () => {
    if (!data) throw new Error('Enterprise data store has not been loaded.');
    return data;
  };

  const save = () => {
    pruneEnterpriseData(get(), retention);
    const content = JSON.stringify(normalize(get()), null, 2);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      const directory = path.dirname(filePath);
      await fs.promises.mkdir(directory, { recursive: true });
      const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
      let handle;
      try {
        handle = await fs.promises.open(tempPath, 'w', 0o600);
        await handle.writeFile(content, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.promises.rename(tempPath, filePath);
        lastSaveError = null;
        lastSavedAt = new Date().toISOString();
      } catch (error) {
        lastSaveError = error;
        if (handle) await handle.close().catch(() => {});
        await fs.promises.unlink(tempPath).catch(() => {});
        throw error;
      }
    });
    return saveQueue;
  };

  const flush = () => saveQueue;
  const health = () => ({ loaded: Boolean(data), lastSavedAt, lastSaveOk: !lastSaveError });
  return { load, get, save, flush, health };
};
