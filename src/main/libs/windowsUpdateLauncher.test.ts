import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

import { buildWindowsUpdateWorker } from './windowsUpdateLauncher';

describe('silent Windows update safety', () => {
  const options = {
    installer: "C:\\Users\\O'Brien\\updates\\update.exe",
    installDir: 'C:\\Program Files\\LFClaw', parentPid: 123,
    readyPath: 'C:\\updates\\ready', cancelPath: 'C:\\updates\\cancel', sha256: 'a'.repeat(64),
  };
  test('waits for graceful exit, verifies integrity, keeps the current path and restarts', () => {
    const script = buildWindowsUpdateWorker(options);
    expect(script).toContain("O''Brien");
    expect(script).toContain('WaitForExit(120000)');
    expect(script.indexOf('WaitForExit')).toBeLessThan(script.indexOf('Start-Process'));
    expect(script).toContain('/S --updated --force-run /D=');
    expect(script).toContain('Get-FileHash -LiteralPath');
    expect(script).not.toMatch(/Stop-Process|Remove-Item|ExecutionPolicy/);
  });
  test('rejects unsafe worker parameters', () => {
    expect(() => buildWindowsUpdateWorker({ ...options, parentPid: -1 })).toThrow();
    expect(() => buildWindowsUpdateWorker({ ...options, sha256: 'no' })).toThrow();
  });
  test('packaging preserves user data and the previous program', () => {
    const config = JSON.parse(fs.readFileSync(path.resolve('electron-builder.json'), 'utf8'));
    expect(config.nsis.deleteAppDataOnUninstall).toBe(false);
    const script = fs.readFileSync(path.resolve('scripts/nsis-installer.nsh'), 'utf8');
    expect(script).not.toContain('rd /s /q');
    expect(script).toContain('Previous installation preserved');
    expect(script).toContain('Stop-Process -Name LFClaw,LobsterAI');
  });
});
