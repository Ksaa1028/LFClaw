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

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

const enterpriseServerUrl = readEnterpriseServerUrl();
const env = {
  ...process.env,
  NODE_ENV: 'development',
  ...(enterpriseServerUrl ? { LFCLAW_ENTERPRISE_BASE_URL: enterpriseServerUrl } : {}),
};

console.log('[LfClaw] starting desktop client with the standard dev pipeline...');
if (enterpriseServerUrl) {
  console.log(`[LfClaw] enterprise server: ${enterpriseServerUrl}`);
}
console.log('[LfClaw] do not start Electron directly; this command builds main/preload first.');

const child = spawn(npmCommand(), ['run', 'electron:dev'], {
  cwd: root,
  env,
  stdio: 'inherit',
  shell: false,
});

child.on('exit', code => {
  process.exit(code ?? 0);
});
