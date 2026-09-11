import crypto from 'crypto';
import fs from 'fs';

export const createReleaseHashCache = () => {
  const cache = new Map();
  const hashFile = async (filePath, stat = fs.statSync(filePath)) => {
    const key = `${stat.size}:${stat.mtimeMs}`;
    const existing = cache.get(filePath);
    if (existing?.key === key) return existing.value;
    const value = new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
    cache.set(filePath, { key, value });
    try {
      return await value;
    } catch (error) {
      if (cache.get(filePath)?.value === value) cache.delete(filePath);
      throw error;
    }
  };
  return { hashFile };
};
