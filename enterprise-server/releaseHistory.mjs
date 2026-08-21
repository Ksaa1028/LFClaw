import crypto from 'crypto';

const clean = value => String(value || '').trim();

export const normalizeReleaseHistory = value => (
  Array.isArray(value)
    ? value.map(item => ({
      id: clean(item?.id),
      version: clean(item?.version),
      description: clean(item?.description),
      createdAt: clean(item?.createdAt),
    })).filter(item => item.id && item.version && item.description && item.createdAt)
    : []
);

export const createReleaseHistoryEntry = (input, createdAt = new Date().toISOString()) => {
  const version = clean(input?.version);
  const description = clean(input?.description);
  if (!version) throw new Error('版本号必填。');
  if (!description) throw new Error('更新描述必填。');
  return {
    id: `release-${crypto.randomUUID()}`,
    version,
    description,
    createdAt,
  };
};
