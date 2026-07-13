#!/usr/bin/env node
'use strict';

/**
 * Collect packaged installers into a small enterprise release channel.
 *
 * Usage:
 *   node scripts/package-release.cjs
 *   node scripts/package-release.cjs --platform windows --release 2026.7.13
 *
 * The script copies installer artifacts from release/ into releases/<platform>/,
 * writes releases/latest.json, and keeps only the latest two release groups per
 * platform. It intentionally does not run electron-builder; run npm run dist:win
 * or the macOS build first.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'release');
const TARGET_DIR = path.join(ROOT, 'releases');
const KEEP_RELEASES = 2;

const PLATFORM_RULES = {
  windows: {
    aliases: new Set(['win', 'windows']),
    directory: 'windows',
    artifactPattern: /\.(exe|msi)$/i,
    sidecarPattern: /\.(blockmap|yml|yaml)$/i,
    installerExts: new Set(['.exe', '.msi']),
  },
  mac: {
    aliases: new Set(['mac', 'macos', 'darwin']),
    directory: 'mac',
    artifactPattern: /\.(dmg|pkg|zip)$/i,
    sidecarPattern: /\.(blockmap|yml|yaml)$/i,
    installerExts: new Set(['.dmg', '.pkg', '.zip']),
  },
};

function parseArgs(argv) {
  const args = {
    platform: 'all',
    release: process.env.LFCLAW_RELEASE_VERSION || '',
    source: SOURCE_DIR,
    target: TARGET_DIR,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--platform' && next) {
      args.platform = next;
      index += 1;
    } else if (arg === '--release' && next) {
      args.release = next;
      index += 1;
    } else if (arg === '--source' && next) {
      args.source = path.resolve(next);
      index += 1;
    } else if (arg === '--target' && next) {
      args.target = path.resolve(next);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.release = sanitizeReleaseId(args.release || defaultReleaseId());
  return args;
}

function printHelp() {
  console.log(`LfClaw release packager

Options:
  --platform windows|mac|all   Platform artifacts to collect. Default: all
  --release <id>               Release id. Default: package version + timestamp
  --source <dir>               electron-builder output dir. Default: release
  --target <dir>               enterprise release dir. Default: releases
`);
}

function defaultReleaseId() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
  ].join('');
  return `${pkg.version}-${stamp}`;
}

function sanitizeReleaseId(value) {
  const safe = String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!safe) throw new Error('Release id is empty');
  return safe.slice(0, 80);
}

function normalizePlatform(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'all') return ['windows', 'mac'];
  for (const [platform, rule] of Object.entries(PLATFORM_RULES)) {
    if (rule.aliases.has(raw)) return [platform];
  }
  throw new Error(`Unsupported platform: ${value}`);
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.endsWith('-unpacked')) continue;
      results.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function detectArch(fileName) {
  const lower = fileName.toLowerCase();
  if (/(arm64|aarch64)/.test(lower)) return 'arm64';
  if (/(x64|amd64)/.test(lower)) return 'x64';
  if (/(ia32|x86)(?!_64)/.test(lower)) return 'ia32';
  return 'x64';
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function fileInfo(filePath, baseDir) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: path.relative(baseDir, filePath).replace(/\\/g, '/'),
    size: stat.size,
    sha256: sha256(filePath),
  };
}

function collectPlatformArtifacts(sourceDir, platform, releaseId, targetDir) {
  const rule = PLATFORM_RULES[platform];
  const files = walkFiles(sourceDir);
  const installers = selectInstallers(files.filter((file) => rule.artifactPattern.test(path.basename(file))));
  if (installers.length === 0) {
    console.warn(`[package-release] no ${platform} installer found in ${sourceDir}`);
    return null;
  }

  const platformDir = path.join(targetDir, rule.directory);
  const releaseDir = path.join(platformDir, releaseId);
  fs.mkdirSync(releaseDir, { recursive: true });

  const copied = [];
  for (const installer of installers) {
    const ext = path.extname(installer).toLowerCase();
    const arch = detectArch(path.basename(installer));
    const targetName = `LfClaw-${releaseId}-${platform}-${arch}${ext}`;
    const targetPath = path.join(releaseDir, targetName);
    fs.copyFileSync(installer, targetPath);
    copied.push(fileInfo(targetPath, targetDir));

    const basename = path.basename(installer);
    const sidecars = files.filter((file) => {
      const sidecarName = path.basename(file);
      if (!rule.sidecarPattern.test(sidecarName)) return false;
      if (sidecarName === `${basename}.blockmap`) return true;
      if (!/\.ya?ml$/i.test(sidecarName)) return false;
      try {
        return fs.readFileSync(file, 'utf8').includes(basename);
      } catch {
        return false;
      }
    });

    for (const sidecar of sidecars) {
      const sidecarTarget = path.join(releaseDir, `${targetName}${path.extname(sidecar)}`);
      fs.copyFileSync(sidecar, sidecarTarget);
      copied.push(fileInfo(sidecarTarget, targetDir));
    }
  }

  pruneOldReleases(platformDir, KEEP_RELEASES);
  return {
    releaseId,
    platform,
    directory: path.relative(targetDir, releaseDir).replace(/\\/g, '/'),
    createdAt: new Date().toISOString(),
    files: copied,
  };
}

function selectInstallers(candidates) {
  const preferred = candidates.filter((file) => /^LfClaw/i.test(path.basename(file)));
  const source = preferred.length > 0 ? preferred : candidates;
  const byTarget = new Map();

  for (const file of source) {
    const ext = path.extname(file).toLowerCase();
    const arch = detectArch(path.basename(file));
    const key = `${arch}:${ext}`;
    const current = byTarget.get(key);
    const mtimeMs = fs.statSync(file).mtimeMs;
    if (!current || mtimeMs > current.mtimeMs) {
      byTarget.set(key, { file, mtimeMs });
    }
  }

  return [...byTarget.values()]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => entry.file);
}

function pruneOldReleases(platformDir, keep) {
  if (!fs.existsSync(platformDir)) return;
  const releases = fs.readdirSync(platformDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(platformDir, entry.name);
      return { name: entry.name, path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of releases.slice(keep)) {
    fs.rmSync(entry.path, { recursive: true, force: true });
    console.log(`[package-release] pruned old release ${entry.path}`);
  }
}

function readExistingLatest(targetDir) {
  const filePath = path.join(targetDir, 'latest.json');
  if (!fs.existsSync(filePath)) {
    return { product: 'LfClaw', generatedAt: '', channels: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return { product: 'LfClaw', generatedAt: '', channels: {} };
  }
}

function writeLatest(targetDir, updates) {
  fs.mkdirSync(targetDir, { recursive: true });
  const latest = readExistingLatest(targetDir);
  latest.product = 'LfClaw';
  latest.generatedAt = new Date().toISOString();
  latest.channels = latest.channels || {};
  for (const update of updates) {
    if (update) latest.channels[update.platform] = update;
  }
  fs.writeFileSync(path.join(targetDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
}

function main() {
  const args = parseArgs(process.argv);
  const platforms = normalizePlatform(args.platform);
  const updates = platforms.map((platform) => (
    collectPlatformArtifacts(args.source, platform, args.release, args.target)
  ));
  writeLatest(args.target, updates);
  console.log(`[package-release] wrote ${path.join(args.target, 'latest.json')}`);
}

try {
  main();
} catch (error) {
  console.error(`[package-release] ${error.message || error}`);
  process.exit(1);
}
