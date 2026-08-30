import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { expect, test, vi } from 'vitest';

const rootDir = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(rootDir, 'scripts/verify-openclaw-runtime.cjs'), 'utf8');

function validator(info: Record<string, unknown>, bundle = 'failed to reconnect server MCP_CATALOG_RETRY_ON_FAILURE') {
  const patches = ['first patch', 'second patch'];
  const patchHash = crypto.createHash('sha256').update(patches.join('')).digest('hex');
  const readFileSync = (name: string) => {
    if (name.endsWith('runtime-build-info.json')) return JSON.stringify(info);
    if (name.endsWith('package.json')) return JSON.stringify({ openclaw: { version: 'v2026.6.1' } });
    if (name.endsWith('gateway-bundle.mjs')) return bundle;
    return name.endsWith('a.patch') ? patches[0] : patches[1];
  };
  const exports = {} as { assertRuntimeCurrent: (root: string, runtime: string, target: string) => void };
  const module = { exports };
  vm.runInNewContext(script, {
    module,
    require: (name: string) => ({ fs: { readFileSync, readdirSync: () => ['z.patch', 'a.patch', 'README.md'] }, path, crypto })[name],
  });
  return { check: () => module.exports.assertRuntimeCurrent('/repo', '/runtime', 'win-x64'), patchHash };
}

test('validates version, sorted patch fingerprint and executable recovery code', () => {
  const { patchHash } = validator({});
  expect(() => validator({ target: 'win-x64', openclawVersion: 'v2026.6.1', patchHash }).check()).not.toThrow();
});
test.each([
  { patchHash: 'old' }, { openclawVersion: 'old' }, { target: 'mac-arm64' },
])('rejects outdated runtime metadata: %j', mismatch => {
  const { patchHash } = validator({});
  expect(() => validator({ target: 'win-x64', openclawVersion: 'v2026.6.1', patchHash, ...mismatch }).check()).toThrow('Runtime is stale');
});
test('matching metadata does not hide missing executable patches', () => {
  const { patchHash } = validator({});
  expect(() => validator({ target: 'win-x64', openclawVersion: 'v2026.6.1', patchHash }, 'old bundle').check()).toThrow('missing MCP recovery');
});

test('default release always enters the fingerprint-aware runtime build before packaging', () => {
  const release = fs.readFileSync(path.join(rootDir, 'scripts/release-lfclaw.cjs'), 'utf8');
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnSync = vi.fn((command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes('openclaw:runtime:win-x64')) throw new Error('runtime-checked');
    return { status: 0 };
  });
  expect(() => vm.runInNewContext(release, {
    __dirname: path.join(rootDir, 'scripts'),
    process: { argv: [], env: { LFCLAW_BUILD_VERSION: '2026082801' }, platform: 'win32' },
    console: { log: vi.fn() },
    require: (name: string) => ({ fs, path, child_process: { spawnSync } })[name],
  })).toThrow('runtime-checked');
  expect(calls.at(-1)).toEqual({ command: 'npm', args: ['run', 'openclaw:runtime:win-x64'] });
  expect(calls.some(call => call.args.includes('electron-builder'))).toBe(false);
});

test.each([
  { argv: [], env: { OPENCLAW_SRC: '/isolated/source' }, expected: '/isolated/source' },
  { argv: ['/explicit/source'], env: { OPENCLAW_SRC: '/isolated/source' }, expected: '/explicit/source' },
  { argv: [], env: {}, expected: path.resolve(rootDir, '..', 'openclaw') },
])('patch application targets the same checkout as the build: %j', ({ argv, env, expected }) => {
  const patcher = fs.readFileSync(path.join(rootDir, 'scripts/apply-openclaw-patches.cjs'), 'utf8');
  const checkedPaths: string[] = [];
  expect(() => vm.runInNewContext(patcher, {
    __dirname: path.join(rootDir, 'scripts'),
    process: { argv: ['node', 'patcher.cjs', ...argv], env },
    require: (name: string) => {
      if (name === 'fs') return {
        existsSync: (name: string) => {
          checkedPaths.push(name);
          throw new Error('source-path-checked');
        },
      };
      if (name === 'path') return path;
      if (name.endsWith('package.json')) return { openclaw: { version: 'v2026.6.1' } };
      return {};
    },
  })).toThrow('source-path-checked');
  expect(checkedPaths).toEqual([path.resolve(expected)]);
});
