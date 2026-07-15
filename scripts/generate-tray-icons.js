#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const inputPath = path.resolve(projectRoot, process.argv[2] || 'public/logo.png');
const outputDir = path.resolve(projectRoot, 'resources', 'tray');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-tray-icons-'));

function psLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertInputExists() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input logo not found: ${inputPath}`);
  }
}

function buildIco(entries, outputPath) {
  let offset = 6 + entries.length * 16;
  const directoryEntries = entries.map((entry) => {
    const current = { ...entry, offset };
    offset += entry.data.length;
    return current;
  });

  const ico = Buffer.alloc(offset);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(directoryEntries.length, 4);

  directoryEntries.forEach((entry, index) => {
    const base = 6 + index * 16;
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, base);
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    ico.writeUInt8(0, base + 2);
    ico.writeUInt8(0, base + 3);
    ico.writeUInt16LE(1, base + 4);
    ico.writeUInt16LE(32, base + 6);
    ico.writeUInt32LE(entry.data.length, base + 8);
    ico.writeUInt32LE(entry.offset, base + 12);
    entry.data.copy(ico, entry.offset);
  });

  fs.writeFileSync(outputPath, ico);
}

function resizeIcons() {
  fs.mkdirSync(outputDir, { recursive: true });

  const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${psLiteral(inputPath)})
function Save-Resized([int] $size, [string] $path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
try {
  Save-Resized 48 (Join-Path ${psLiteral(outputDir)} 'tray-icon.png')
  Save-Resized 18 (Join-Path ${psLiteral(outputDir)} 'tray-icon-mac.png')
  Save-Resized 36 (Join-Path ${psLiteral(outputDir)} 'tray-icon-mac@2x.png')
  Save-Resized 16 (Join-Path ${psLiteral(tmpDir)} 'tray-16.png')
  Save-Resized 32 (Join-Path ${psLiteral(tmpDir)} 'tray-32.png')
  Save-Resized 48 (Join-Path ${psLiteral(tmpDir)} 'tray-48.png')
} finally {
  $src.Dispose()
}
`;

  const scriptPath = path.join(tmpDir, 'resize.ps1');
  fs.writeFileSync(scriptPath, script, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: 'inherit' });
}

function writeWindowsTrayIco() {
  const entries = [16, 32, 48].map((size) => ({
    size,
    data: fs.readFileSync(path.join(tmpDir, `tray-${size}.png`)),
  }));
  buildIco(entries, path.join(outputDir, 'tray-icon.ico'));
}

function main() {
  assertInputExists();
  resizeIcons();
  writeWindowsTrayIco();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`Generated tray icons from ${inputPath} -> ${outputDir}`);
}

try {
  main();
} catch (error) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
