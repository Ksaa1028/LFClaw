import crypto from 'crypto';

export const normalizeSha256 = (value?: string): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
};

export const shouldUpgradeEnterpriseSkill = (options: {
  isInstalled: boolean;
  installedPackageSha256?: string;
  serverPackageSha256?: string;
}): boolean => {
  const installedHash = normalizeSha256(options.installedPackageSha256);
  const serverHash = normalizeSha256(options.serverPackageSha256);
  return Boolean(options.isInstalled && installedHash && serverHash && installedHash !== serverHash);
};

export const verifyEnterpriseSkillPackageHash = (
  buffer: Buffer,
  expectedSha256?: string,
): string => {
  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const expected = normalizeSha256(expectedSha256);
  if (expected && actualSha256 !== expected) {
    throw new Error(`Package SHA-256 mismatch: expected ${expected}, got ${actualSha256}`);
  }
  return actualSha256;
};
