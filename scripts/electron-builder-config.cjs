'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../electron-builder.json');

const DEFAULT_KEYFROM = 'official';
const KEYFROM_PATTERN = /^[a-z0-9_-]{1,64}$/;
const BUILD_VERSION_PATTERN = /^\d{10}$/;

function normalizeKeyfrom(value) {
  if (typeof value !== 'string') return DEFAULT_KEYFROM;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return DEFAULT_KEYFROM;
  if (!KEYFROM_PATTERN.test(normalized)) return DEFAULT_KEYFROM;
  return normalized;
}

function readBuildKeyfrom() {
  if (process.env.KEYFROM !== undefined) {
    return normalizeKeyfrom(process.env.KEYFROM);
  }

  const buildInfoPath = path.join(__dirname, '..', '.keyfrom-build', 'keyfrom.json');
  try {
    if (!fs.existsSync(buildInfoPath)) {
      return DEFAULT_KEYFROM;
    }
    const parsed = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
    return normalizeKeyfrom(parsed?.keyfrom);
  } catch (error) {
    console.warn('[Keyfrom] failed to read build keyfrom for artifact names, using official:', error);
    return DEFAULT_KEYFROM;
  }
}

function normalizeBuildVersion(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return BUILD_VERSION_PATTERN.test(normalized) ? normalized : null;
}

function readLFClawBuildVersion() {
  const envVersion = normalizeBuildVersion(process.env.LFCLAW_BUILD_VERSION);
  if (envVersion) {
    return envVersion;
  }

  const buildVersionPath = path.join(__dirname, '..', '.lfclaw-build', 'build-version.json');
  try {
    if (fs.existsSync(buildVersionPath)) {
      const parsed = JSON.parse(fs.readFileSync(buildVersionPath, 'utf8'));
      const fileVersion = normalizeBuildVersion(parsed?.version);
      if (fileVersion) {
        return fileVersion;
      }
    }
  } catch (error) {
    console.warn('[LFClaw Build] failed to read build version for artifact names:', error);
  }

  return '${version}';
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function resourceKey(resource) {
  if (typeof resource === 'string') return `string:${resource}`;
  return `${resource?.from || ''}->${resource?.to || ''}`;
}

function mergeExtraResources(platformName) {
  const baseResources = asArray(config.extraResources);
  const platformConfig = config[platformName] || {};
  const platformResources = asArray(platformConfig.extraResources);
  const merged = [];
  const seen = new Set();

  for (const resource of [...baseResources, ...platformResources]) {
    const key = resourceKey(resource);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(resource);
  }

  config[platformName] = {
    ...platformConfig,
    extraResources: merged,
  };
}

const keyfrom = readBuildKeyfrom();
const buildVersion = readLFClawBuildVersion();

for (const platformName of ['mac', 'win', 'linux']) {
  mergeExtraResources(platformName);
}

delete config.extraResources;

config.dmg = {
  ...(config.dmg || {}),
  artifactName: `LFClaw-${buildVersion}-mac-\${arch}-${keyfrom}.\${ext}`,
};

config.nsis = {
  ...(config.nsis || {}),
  artifactName: `LFClaw-Setup-${buildVersion}-win-\${arch}-${keyfrom}.\${ext}`,
};

console.log(`[Keyfrom] configured artifact keyfrom as ${keyfrom}`);
console.log(`[LFClaw Build] configured artifact build version as ${buildVersion}`);

module.exports = config;
