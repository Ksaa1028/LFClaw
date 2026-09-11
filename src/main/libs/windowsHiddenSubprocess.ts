import fs from 'fs';
import path from 'path';

// Loaded only by the Windows gateway, never by the Electron main process.
// NODE_OPTIONS carries this app-owned hook through shells to Node CLI wrappers
// (such as lark-cli), whose synchronous children otherwise open console windows.
export const WINDOWS_HIDDEN_SUBPROCESS_SOURCE = String.raw`
'use strict';
if (process.platform === 'win32') {
  const cp = require('node:child_process');
  const preload = '--require=' + JSON.stringify(__filename.replace(/\\/g, '/'));
  const installed = Symbol.for('lfclaw.hiddenSubprocessInstalled');
  if (!cp[installed]) {
    cp[installed] = true;
    const hiddenOptions = (options) => {
      const original = options || {};
      if (original.windowsHide === false) return original;
      const env = { ...(original.env || process.env) };
      const nodeOptions = env.NODE_OPTIONS || '';
      // Preserve only the caller's environment; do not restore variables
      // removed by OpenClaw's command-environment sanitization.
      env.NODE_OPTIONS = nodeOptions.includes(preload)
        ? nodeOptions
        : [nodeOptions, preload].filter(Boolean).join(' ');
      return { ...original, windowsHide: true, env };
    };
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
      const original = cp[name];
      cp[name] = function (...args) {
        const index = name === 'exec' || name === 'execSync'
          ? 1
          : Array.isArray(args[1]) ? 2 : 1;
        if (args[index] == null) {
          args[index] = hiddenOptions();
        } else if (typeof args[index] === 'function') {
          args.splice(index, 0, hiddenOptions());
        } else {
          args[index] = hiddenOptions(args[index]);
        }
        return original.apply(this, args);
      };
    }
    require('node:module').syncBuiltinESMExports();
  }
}
`;

export function ensureWindowsHiddenSubprocessArgs(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') return [];
  const filePath = path.join(directory, 'windows-hidden-subprocess.cjs');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== WINDOWS_HIDDEN_SUBPROCESS_SOURCE) {
    fs.writeFileSync(filePath, WINDOWS_HIDDEN_SUBPROCESS_SOURCE, 'utf8');
  }
  return ['--require', filePath];
}
