'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const buildVersionPath = path.join(rootDir, '.lfclaw-build', 'build-version.json');
const releaseDir = path.join(rootDir, 'release');

function readBuildVersion() {
  const envVersion = process.env.LFCLAW_BUILD_VERSION?.trim();
  if (/^\d{10}$/.test(envVersion || '')) return envVersion;

  const parsed = JSON.parse(fs.readFileSync(buildVersionPath, 'utf8'));
  const version = String(parsed.version || '').trim();
  if (!/^\d{10}$/.test(version)) {
    throw new Error('Missing LFClaw build version. Run npm run build:version first.');
  }
  return version;
}

function runGit(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function envLines() {
  const text = process.env.LFCLAW_CHANGELOG?.trim();
  if (!text) return [];
  return text.split(/\r?\n|;|；/).map(line => line.trim()).filter(Boolean);
}

function changedFiles() {
  const output = runGit('diff --name-only HEAD');
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function recentCommitLines() {
  const output = runGit('log -5 --pretty=%s');
  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}

function inferLinesFromFiles(files) {
  const lines = [];
  const hasEnterpriseServer = files.some(file => file.startsWith('enterprise-server/'));
  const hasUpdate = files.some(file => file.includes('appUpdate') || file.includes('electron-builder') || file.includes('build-version'));
  const hasDocs = files.some(file => file.toLowerCase().endsWith('.md'));
  const hasPackage = files.some(file => file === 'package.json' || file === 'electron-builder.json');

  if (hasEnterpriseServer) lines.push('优化企业管理服务与版本更新源。');
  if (hasUpdate) lines.push('完善客户端自动更新检测、版本号和打包流程。');
  if (hasPackage) lines.push('调整客户端打包配置和发布产物命名规则。');
  if (hasDocs) lines.push('更新部署、打包和运维说明文档。');

  return lines;
}

function fallbackLines() {
  const files = changedFiles();
  const inferred = inferLinesFromFiles(files);
  if (inferred.length > 0) return inferred;

  const commits = recentCommitLines();
  if (commits.length > 0) {
    return commits.map(line => line.replace(/^[a-z]+(?:\([^)]+\))?:\s*/i, '').trim()).filter(Boolean);
  }

  return ['更新 LFClaw 客户端。'];
}

function main() {
  const version = readBuildVersion();
  const lines = envLines();
  const changelogLines = lines.length > 0 ? lines : fallbackLines();
  fs.mkdirSync(releaseDir, { recursive: true });

  const filePath = path.join(releaseDir, `changelog-${version}.zh.txt`);
  fs.writeFileSync(filePath, `${changelogLines.join('\n')}\n`, 'utf8');
  console.log(`[LFClaw Build] release changelog: ${filePath}`);
}

main();
