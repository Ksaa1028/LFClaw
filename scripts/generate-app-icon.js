#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const source = path.resolve(projectRoot, process.argv[2] || 'public/logo.png');
const pngDir = path.join(projectRoot, 'build', 'icons', 'png');
const winDir = path.join(projectRoot, 'build', 'icons', 'win');
const macDir = path.join(projectRoot, 'build', 'icons', 'mac');
const outIco = path.join(winDir, 'icon.ico');
const outIcns = path.join(macDir, 'icon.icns');
const pngSizes = [1024, 512, 256, 128, 64, 48, 32, 24, 16];
const icoSizes = [256, 128, 64, 48, 32, 16];
const macIconEntries = [
  { file: 'icon_16x16.png', size: 16 },
  { file: 'icon_16x16@2x.png', size: 32 },
  { file: 'icon_32x32.png', size: 32 },
  { file: 'icon_32x32@2x.png', size: 64 },
  { file: 'icon_128x128.png', size: 128 },
  { file: 'icon_128x128@2x.png', size: 256 },
  { file: 'icon_256x256.png', size: 256 },
  { file: 'icon_256x256@2x.png', size: 512 },
  { file: 'icon_512x512.png', size: 512 },
  { file: 'icon_512x512@2x.png', size: 1024 },
];

function assertSource() {
  if (!fs.existsSync(source)) {
    throw new Error(`Icon source not found: ${source}`);
  }
}

function psLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function resizePngsWithPowerShell() {
  fs.mkdirSync(pngDir, { recursive: true });
  fs.mkdirSync(winDir, { recursive: true });

  const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile(${psLiteral(source)})
try {
  $sizes = @(${pngSizes.join(',')})
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, 0, 0, $s, $s)
    $g.Dispose()
    $outPath = Join-Path ${psLiteral(pngDir)} "$($s)x$($s).png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  }
} finally {
  $src.Dispose()
}
`;

  const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-icons-')), 'resize.ps1');
  fs.writeFileSync(scriptPath, script, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { stdio: 'inherit' });
  fs.rmSync(path.dirname(scriptPath), { recursive: true, force: true });
}

function resizePngsWithSips() {
  fs.mkdirSync(pngDir, { recursive: true });
  pngSizes.forEach((size) => {
    execFileSync('/usr/bin/sips', [
      '-s',
      'format',
      'png',
      '-z',
      String(size),
      String(size),
      source,
      '--out',
      path.join(pngDir, `${size}x${size}.png`),
    ], { stdio: 'inherit' });
  });
}

function writeMacIcns() {
  if (process.platform !== 'darwin') return;
  fs.mkdirSync(macDir, { recursive: true });
  const iconsetDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lfclaw-iconset-')), 'icon.iconset');
  fs.mkdirSync(iconsetDir, { recursive: true });

  try {
    macIconEntries.forEach((entry) => {
      const sourcePng = path.join(pngDir, `${entry.size}x${entry.size}.png`);
      if (!fs.existsSync(sourcePng)) {
        throw new Error(`Missing PNG for macOS icon: ${sourcePng}`);
      }
      fs.copyFileSync(sourcePng, path.join(iconsetDir, entry.file));
    });
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', outIcns], { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(iconsetDir), { recursive: true, force: true });
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

function writeWindowsIco() {
  fs.mkdirSync(winDir, { recursive: true });
  const entries = icoSizes.map((size) => ({
    size,
    data: fs.readFileSync(path.join(pngDir, `${size}x${size}.png`)),
  }));
  buildIco(entries, outIco);
}

function main() {
  assertSource();
  if (process.platform === 'win32') {
    resizePngsWithPowerShell();
    writeWindowsIco();
  } else if (process.platform === 'darwin') {
    resizePngsWithSips();
    writeMacIcns();
  } else {
    throw new Error('App icon generation currently supports Windows and macOS hosts only.');
  }
  console.log(`Generated app icons from ${source}`);
  console.log(`- ${pngDir}`);
  if (process.platform === 'win32') console.log(`- ${outIco}`);
  if (process.platform === 'darwin') console.log(`- ${outIcns}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
