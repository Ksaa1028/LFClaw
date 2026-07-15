#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const enterpriseConfigPath = path.join(root, 'resources', 'enterprise.json');

function readEnterpriseServerUrl() {
  if (process.env.LFCLAW_ENTERPRISE_BASE_URL) {
    return process.env.LFCLAW_ENTERPRISE_BASE_URL;
  }
  try {
    const raw = fs.readFileSync(enterpriseConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.enterpriseServerUrl || '';
  } catch {
    return '';
  }
}

function npmCommandAndArgs() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath],
    };
  }
  const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(bundledNpmCli)) {
    return {
      command: process.execPath,
      args: [bundledNpmCli],
    };
  }
  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [],
  };
}

const enterpriseServerUrl = readEnterpriseServerUrl();
const pathEnvKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
const nodeBinDir = path.dirname(process.execPath);
const env = {
  ...process.env,
  NODE_ENV: 'development',
  [pathEnvKey]: `${nodeBinDir}${path.delimiter}${process.env[pathEnvKey] || ''}`,
  ...(enterpriseServerUrl ? { LFCLAW_ENTERPRISE_BASE_URL: enterpriseServerUrl } : {}),
};

console.log('[LfClaw] starting desktop client with the standard dev pipeline...');
if (enterpriseServerUrl) {
  console.log(`[LfClaw] enterprise server: ${enterpriseServerUrl}`);
}
console.log('[LfClaw] do not start Electron directly; this command builds main/preload first.');

const npm = npmCommandAndArgs();
const child = spawn(npm.command, [...npm.args, 'run', 'electron:dev'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on('exit', code => {
  process.exit(code ?? 0);
});
