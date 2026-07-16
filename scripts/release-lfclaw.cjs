'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'release');
const buildVersionPath = path.join(rootDir, '.lfclaw-build', 'build-version.json');
const runtimeInfoPath = path.join(rootDir, 'vendor', 'openclaw-runtime', 'current', 'runtime-build-info.json');
const VERSION_PATTERN = /^\d{10}$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function todayPrefix() {
  const now = new Date();
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

function parseArgs() {
  const options = {
    platform: 'win',
    arch: 'x64',
    withRuntime: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--with-runtime') {
      options.withRuntime = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.+)$/);
    if (!match) continue;
    if (match[1] === 'platform') options.platform = match[2];
    if (match[1] === 'arch') options.arch = match[2];
  }

  if (!['win', 'mac'].includes(options.platform)) {
    throw new Error('Release platform must be win or mac.');
  }
  if (!['x64', 'arm64'].includes(options.arch)) {
    throw new Error('Release arch must be x64 or arm64.');
  }
  if (options.platform === 'win' && options.arch !== 'x64') {
    throw new Error('Windows release currently supports x64 only.');
  }
  return options;
}

function packageFileName(version, platform, arch) {
  if (platform === 'win') {
    return `LFClaw-Setup-${version}-win-${arch}-official.exe`;
  }
  return `LFClaw-${version}-mac-${arch}-official.dmg`;
}

function releasePattern(prefix, platform, arch) {
  if (platform === 'win') {
    return new RegExp(`^LFClaw-Setup-(${prefix})(\\d{2})-win-${arch}-.*\\.exe$`);
  }
  return new RegExp(`^LFClaw-(${prefix})(\\d{2})-mac-${arch}-.*\\.dmg$`);
}

function resolveVersion(platform, arch) {
  const explicit = process.env.LFCLAW_BUILD_VERSION?.trim();
  if (explicit) {
    if (!VERSION_PATTERN.test(explicit)) {
      throw new Error('LFCLAW_BUILD_VERSION must use YYYYMMDDNN, for example 2026071601.');
    }
    return explicit;
  }

  const seq = process.env.LFCLAW_BUILD_SEQ?.trim();
  if (seq) {
    const parsed = Number.parseInt(seq, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 99) {
      throw new Error('LFCLAW_BUILD_SEQ must be a number between 1 and 99.');
    }
    return `${todayPrefix()}${pad2(parsed)}`;
  }

  const prefix = todayPrefix();
  let maxSeq = 0;
  const pattern = releasePattern(prefix, platform, arch);
  if (fs.existsSync(releaseDir)) {
    for (const entry of fs.readdirSync(releaseDir)) {
      const match = entry.match(pattern);
      if (!match) continue;
      maxSeq = Math.max(maxSeq, Number.parseInt(match[2], 10));
    }
  }
  return `${prefix}${pad2(maxSeq + 1)}`;
}

function run(label, command, args, env) {
  console.log(`\n[LFClaw Release] ${label}`);
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env,
    shell: true,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

function readRuntimeTarget() {
  try {
    if (!fs.existsSync(runtimeInfoPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(runtimeInfoPath, 'utf8'));
    return typeof parsed?.target === 'string' ? parsed.target : null;
  } catch {
    return null;
  }
}

function ensureChangelogEnv(env) {
  if (env.LFCLAW_CHANGELOG?.trim()) return env;
  return {
    ...env,
    LFCLAW_CHANGELOG: [
      '更新 LFClaw 客户端。',
      '优化企业版体验与发布流程。',
    ].join('\n'),
  };
}

function runtimeTarget(platform, arch) {
  if (platform === 'win') return `win-${arch}`;
  return `mac-${arch}`;
}

function verifyRelease(version, platform, arch) {
  const packagePath = path.join(releaseDir, packageFileName(version, platform, arch));
  const changelogPath = path.join(releaseDir, `changelog-${version}.zh.txt`);

  if (!fs.existsSync(packagePath)) {
    throw new Error(`Release package missing: ${packagePath}`);
  }
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`Release changelog missing: ${changelogPath}`);
  }

  const buildVersion = JSON.parse(fs.readFileSync(buildVersionPath, 'utf8'));
  if (buildVersion.version !== version) {
    throw new Error(`Build version mismatch: expected ${version}, got ${buildVersion.version}`);
  }

  const changelogText = fs.readFileSync(changelogPath, 'utf8').trim();
  if (!changelogText || changelogText.includes('\uFFFD')) {
    throw new Error(`Release changelog is empty or invalid: ${changelogPath}`);
  }

  const packageSize = fs.statSync(packagePath).size;
  const minSize = platform === 'win' ? 100 * 1024 * 1024 : 50 * 1024 * 1024;
  if (packageSize < minSize) {
    throw new Error(`Release package looks too small: ${packagePath}`);
  }

  console.log('\n[LFClaw Release] done');
  console.log(`Version: ${version}`);
  console.log(`Package: ${packagePath}`);
  console.log(`Changelog: ${changelogPath}`);
}

function ensureHostCanBuild(platform) {
  if (platform === 'mac' && process.platform !== 'darwin') {
    throw new Error('macOS packages must be built on a Mac. Pull this Git repo on macOS and run the same command there.');
  }
}

function main() {
  const options = parseArgs();
  ensureHostCanBuild(options.platform);

  const version = resolveVersion(options.platform, options.arch);
  const env = ensureChangelogEnv({
    ...process.env,
    LFCLAW_BUILD_VERSION: version,
  });
  const target = runtimeTarget(options.platform, options.arch);

  console.log(`[LFClaw Release] ${options.platform} ${options.arch} version ${version}`);
  run('prepare icons', 'npm', ['run', 'sync:icons'], env);
  run('prepare channel info', 'node', ['scripts/generate-keyfrom-build-info.cjs'], env);
  run('write build version', 'npm', ['run', 'build:version'], env);
  run('write changelog', 'npm', ['run', 'build:changelog'], env);

  const currentRuntimeTarget = readRuntimeTarget();
  if (options.withRuntime || currentRuntimeTarget !== target) {
    const reason = options.withRuntime ? 'requested' : `current runtime is ${currentRuntimeTarget || 'missing'}`;
    console.log(`[LFClaw Release] building OpenClaw runtime because ${reason}.`);
    run('build OpenClaw runtime', 'npm', ['run', `openclaw:runtime:${target}`], env);
  } else {
    console.log(`[LFClaw Release] OpenClaw runtime is already ${target}, skip rebuild.`);
  }

  if (options.platform === 'win') {
    run('prepare Python runtime', 'npm', ['run', 'setup:python-runtime'], env);
  }

  run('build renderer', 'npx', ['tsc'], env);
  run('bundle renderer', 'npx', ['vite', 'build'], env);
  run('compile Electron main process', 'npm', ['run', 'compile:electron'], env);
  run('build skills', 'npm', ['run', 'build:skills'], env);

  if (options.platform === 'win') {
    run('package Windows installer', 'npx', ['electron-builder', '--win', '--x64', '--config', 'scripts/electron-builder-config.cjs'], env);
  } else {
    run(`package macOS ${options.arch} dmg`, 'npx', ['electron-builder', '--mac', `--${options.arch}`, '--config', 'scripts/electron-builder-config.cjs'], env);
  }

  verifyRelease(version, options.platform, options.arch);
}

main();
