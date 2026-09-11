import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test, vi } from 'vitest';
import vm from 'vm';

import { ensureWindowsHiddenSubprocessArgs, WINDOWS_HIDDEN_SUBPROCESS_SOURCE } from './windowsHiddenSubprocess';

function harness(platform = 'win32') {
  const cp = Object.fromEntries(
    ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']
      .map(name => [name, vi.fn<(...args: unknown[]) => string>(() => 'result')]),
  );
  const originals = { ...cp };
  const env = { PATH: 'test-path', NODE_OPTIONS: '--trace-warnings' };
  const context = vm.createContext({
    process: { platform, env },
    __filename: 'C:\\LF Claw\\运行时\\hidden.cjs',
    require: (name: string) => name === 'node:child_process' ? cp : { syncBuiltinESMExports: vi.fn() },
  });
  vm.runInContext(WINDOWS_HIDDEN_SUBPROCESS_SOURCE, context);
  return { cp, originals, env, context };
}

describe('Windows hidden subprocess hook', () => {
  test.each(['spawn', 'spawnSync', 'execFile', 'execFileSync'])('%s preserves arguments and hides nested CLI processes', name => {
    const { cp, originals, env } = harness();
    const options = { stdio: 'inherit', env: { PATH: 'sanitized-path' } };
    expect(cp[name]('lark-cli.exe', ['--version'], options)).toBe('result');
    const [file, args, passed] = originals[name].mock.calls[0] as unknown as [string, string[], typeof options & { windowsHide: boolean }];
    expect(file).toBe('lark-cli.exe');
    expect(args).toEqual(['--version']);
    expect(passed).toMatchObject({ stdio: 'inherit', windowsHide: true });
    expect(passed.env).toEqual({ PATH: 'sanitized-path', NODE_OPTIONS: '--require="C:/LF Claw/运行时/hidden.cjs"' });
    expect(options).toEqual({ stdio: 'inherit', env: { PATH: 'sanitized-path' } });
    expect(env.NODE_OPTIONS).toBe('--trace-warnings');
  });

  test.each(['exec', 'execSync'])('%s preserves shell commands', name => {
    const { cp, originals } = harness();
    cp[name]('lark-cli --version');
    expect(originals[name]).toHaveBeenCalledWith('lark-cli --version', expect.objectContaining({ windowsHide: true }));
  });

  test('preserves callback overloads and explicit visible windows', () => {
    const { cp, originals } = harness();
    const callback = vi.fn();
    cp.execFile('tool.exe', callback);
    expect(originals.execFile).toHaveBeenCalledWith('tool.exe', expect.objectContaining({ windowsHide: true }), callback);
    cp.execFile('tool.exe', ['arg'], callback);
    expect(originals.execFile).toHaveBeenLastCalledWith('tool.exe', ['arg'], expect.objectContaining({ windowsHide: true }), callback);
    const visible = { windowsHide: false };
    cp.spawn('tool.exe', visible);
    expect(originals.spawn).toHaveBeenCalledWith('tool.exe', visible);
  });

  test('does not duplicate preload options or install the hook twice', () => {
    const { cp, originals, context } = harness();
    cp.spawn('node', []);
    const options = (originals.spawn.mock.calls[0] as unknown[])[2];
    vm.runInContext(WINDOWS_HIDDEN_SUBPROCESS_SOURCE, context);
    cp.spawn('node', [], options);
    expect((originals.spawn.mock.calls[1] as unknown[])[2]).toEqual(options);
  });

  test('does nothing on non-Windows platforms', () => {
    const { cp, originals } = harness('linux');
    cp.spawn('node', []);
    expect(originals.spawn).toHaveBeenCalledWith('node', []);
  });

  test('writes the preload idempotently, and only on Windows', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-hidden-'));
    try {
      expect(ensureWindowsHiddenSubprocessArgs(directory, 'linux')).toEqual([]);
      expect(fs.readdirSync(directory)).toEqual([]);
      const args = ensureWindowsHiddenSubprocessArgs(directory, 'win32');
      expect(args[0]).toBe('--require');
      expect(fs.readFileSync(args[1], 'utf8')).toBe(WINDOWS_HIDDEN_SUBPROCESS_SOURCE);
      expect(ensureWindowsHiddenSubprocessArgs(directory, 'win32')).toEqual(args);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'win32')('propagates through a real Node wrapper without changing output or exit codes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw hidden '));
    try {
      const preloadArgs = ensureWindowsHiddenSubprocessArgs(directory);
      const childCode = 'process.stdout.write(process.env.NODE_OPTIONS); process.stderr.write("test-stderr"); process.exit(7);';
      const wrapperCode = `
        const cp = require('node:child_process');
        const result = cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(childCode)}], {
          env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8'
        });
        process.stdout.write(JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
      `;
      const result = spawnSync(process.execPath, [...preloadArgs, '-e', wrapperCode], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        status: 7,
        stdout: `--require=${JSON.stringify(preloadArgs[1].replace(/\\/g, '/'))}`,
        stderr: 'test-stderr',
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
