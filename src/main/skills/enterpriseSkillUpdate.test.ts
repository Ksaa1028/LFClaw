import crypto from 'crypto';
import { describe, expect, test } from 'vitest';

import {
  normalizeSha256,
  shouldUpgradeEnterpriseSkill,
  verifyEnterpriseSkillPackageHash,
} from './enterpriseSkillUpdate';

describe('enterprise skill updates', () => {
  test('normalizes hashes before comparing them', () => {
    expect(normalizeSha256(' ABC123 ')).toBe('abc123');
    expect(shouldUpgradeEnterpriseSkill({
      isInstalled: true,
      installedPackageSha256: ' ABC123 ',
      serverPackageSha256: 'abc123',
    })).toBe(false);
  });

  test('upgrades only an installed skill with two different known hashes', () => {
    expect(shouldUpgradeEnterpriseSkill({
      isInstalled: true,
      installedPackageSha256: 'old',
      serverPackageSha256: 'new',
    })).toBe(true);
    expect(shouldUpgradeEnterpriseSkill({
      isInstalled: false,
      installedPackageSha256: 'old',
      serverPackageSha256: 'new',
    })).toBe(false);
    expect(shouldUpgradeEnterpriseSkill({
      isInstalled: true,
      serverPackageSha256: 'new',
    })).toBe(false);
  });

  test('accepts a matching package hash', () => {
    const buffer = Buffer.from('enterprise skill package');
    const expected = crypto.createHash('sha256').update(buffer).digest('hex');
    expect(verifyEnterpriseSkillPackageHash(buffer, expected.toUpperCase())).toBe(expected);
  });

  test('rejects a mismatched package hash', () => {
    expect(() => verifyEnterpriseSkillPackageHash(Buffer.from('tampered'), 'deadbeef'))
      .toThrow('Package SHA-256 mismatch');
  });
});
