import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const encode = (value: string): string => Buffer.from(value, 'utf16le').toString('base64');

export function buildWindowsUpdateWorker(options: {
  installer: string; installDir: string; parentPid: number; readyPath: string; cancelPath: string; sha256: string;
}): string {
  if (!Number.isSafeInteger(options.parentPid) || options.parentPid <= 0 || !/^[a-f0-9]{64}$/.test(options.sha256)) {
    throw new Error('Invalid update worker parameters');
  }
  return `$ErrorActionPreference = 'Stop'
$installer = ${quote(options.installer)}
$installDir = ${quote(options.installDir)}
$readyPath = ${quote(options.readyPath)}
$cancelPath = ${quote(options.cancelPath)}
try {
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne ${quote(options.sha256)}) { throw 'Update checksum mismatch' }
  $parent = Get-Process -Id ${options.parentPid} -ErrorAction Stop
  [IO.File]::WriteAllText($readyPath, 'ready')
  if (-not $parent.WaitForExit(120000)) { throw 'Application did not exit; update cancelled' }
  if (Test-Path -LiteralPath $cancelPath) { exit 1 }
  $arguments = '/S --updated --force-run /D=' + $installDir
  $installerProcess = Start-Process -FilePath $installer -ArgumentList $arguments -PassThru -Wait
  if ($installerProcess.ExitCode -ne 0) { throw ('Installer exit code: ' + $installerProcess.ExitCode) }
  [IO.File]::WriteAllText($readyPath + '.result', 'installed')
} catch {
  [IO.File]::WriteAllText($readyPath + '.result', $_.Exception.Message)
  exit 1
}`;
}

/** Elevate before quitting. The worker never kills the running application. */
export async function launchWindowsUpdate(installer: string, executable: string): Promise<() => Promise<void>> {
  const installDir = path.win32.dirname(executable);
  if (!path.win32.isAbsolute(executable) || installDir === path.win32.parse(installDir).root) {
    throw new Error('Invalid application installation directory');
  }
  const workerDir = await fs.promises.mkdtemp(path.join(path.dirname(installer), 'install-'));
  const readyPath = path.join(workerDir, 'ready');
  const cancelPath = path.join(workerDir, 'cancel');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(installer)) hash.update(chunk);
  const script = buildWindowsUpdateWorker({ installer, installDir, parentPid: process.pid, readyPath, cancelPath, sha256: hash.digest('hex') });
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const bootstrap = `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ${quote(powershell)} -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${encode(script)}' | Out-Null`;
  const cancel = async () => { await fs.promises.writeFile(cancelPath, 'cancel'); };
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(bootstrap)],
        { windowsHide: true, timeout: 120_000 }, error => error ? reject(error) : resolve());
    });
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(readyPath)) {
      if (fs.existsSync(`${readyPath}.result`) || Date.now() >= deadline) throw new Error('Update worker failed to start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return cancel;
  } catch (error) {
    await cancel();
    throw error;
  }
}
