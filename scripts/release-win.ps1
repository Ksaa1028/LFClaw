[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$NoOpenFolder
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $repoRoot 'release'
$releaseToolsDir = Join-Path $repoRoot '.release-tools'
$requiredNodeVersion = [version]'24.15.0'
$portableNodeDirName = "node-v$requiredNodeVersion-win-x64"

function Get-NodeVersion {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }

  try {
    $rawVersion = (& $Path '--version' 2>$null).Trim()
    if ($LASTEXITCODE -ne 0 -or $rawVersion -notmatch '^v(?<version>\d+\.\d+\.\d+)$') {
      return $null
    }
    return [version]$Matches.version
  } catch {
    return $null
  }
}

function Test-NodeExecutable {
  param([string]$Path)
  $version = Get-NodeVersion -Path $Path
  return $null -ne $version -and $version.Major -eq 24 -and $version -ge $requiredNodeVersion
}

function Install-PortableReleaseNode {
  $nodeDir = Join-Path $releaseToolsDir $portableNodeDirName
  $nodeExe = Join-Path $nodeDir 'node.exe'
  if (Test-NodeExecutable -Path $nodeExe) {
    return $nodeExe
  }

  $archivePath = Join-Path $releaseToolsDir "$portableNodeDirName.zip"
  $downloadUrl = "https://nodejs.org/dist/v$requiredNodeVersion/$portableNodeDirName.zip"
  New-Item -ItemType Directory -Path $releaseToolsDir -Force | Out-Null

  Write-Host "Compatible Node.js was not found. Downloading portable Node.js v$requiredNodeVersion..." -ForegroundColor Yellow
  try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing
    if (Test-Path -LiteralPath $nodeDir) {
      Remove-Item -LiteralPath $nodeDir -Recurse -Force
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $releaseToolsDir -Force
  } finally {
    if (Test-Path -LiteralPath $archivePath) {
      Remove-Item -LiteralPath $archivePath -Force
    }
  }

  if (-not (Test-NodeExecutable -Path $nodeExe)) {
    throw "Portable Node.js setup failed. Expected: $nodeExe"
  }
  return $nodeExe
}

function Get-ReleaseNode {
  $candidates = New-Object System.Collections.Generic.List[string]

  if ($env:LFCLAW_NODE_EXE) {
    [void]$candidates.Add($env:LFCLAW_NODE_EXE)
  }

  if ($env:USERPROFILE) {
    $nvmVersions = Join-Path $env:USERPROFILE '.nvmd\versions'
    if (Test-Path -LiteralPath $nvmVersions -PathType Container) {
      Get-ChildItem -LiteralPath $nvmVersions -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object { [version]$_.Name } -Descending |
        ForEach-Object { [void]$candidates.Add((Join-Path $_.FullName 'node.exe')) }
    }
  }

  if ($env:ProgramFiles) {
    [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
  }
  if ($env:LOCALAPPDATA) {
    [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'nvm\nodejs\node.exe'))
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if (Test-NodeExecutable $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return Install-PortableReleaseNode
}

function Stop-LFClawDevelopmentProcesses {
  $escapedRoot = [regex]::Escape($repoRoot)
  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @('node.exe', 'electron.exe', 'esbuild.exe') -and
      (($_.ExecutablePath -and $_.ExecutablePath -match "^$escapedRoot([\\/]|$)") -or
       ($_.CommandLine -and $_.CommandLine -match $escapedRoot))
    }

  if (-not $processes) {
    return
  }

  Write-Host ''
  Write-Host 'LFClaw development processes are running and would lock packaging files.' -ForegroundColor Yellow
  Write-Host 'Closing only Node/Electron processes launched from this repository...'
  $processes |
    Sort-Object ProcessId -Descending |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 300
    $remaining = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Name -in @('node.exe', 'electron.exe', 'esbuild.exe') -and
        (($_.ExecutablePath -and $_.ExecutablePath -match "^$escapedRoot([\\/]|$)") -or
         ($_.CommandLine -and $_.CommandLine -match $escapedRoot))
      }
  } while ($remaining -and (Get-Date) -lt $deadline)

  if ($remaining) {
    $ids = ($remaining | Select-Object -ExpandProperty ProcessId) -join ', '
    throw "Could not close LFClaw development processes: $ids. Close LFClaw and try again."
  }

  Write-Host 'Development processes closed; packaging files are available.' -ForegroundColor Green
}

function Get-NpmCommand {
  param([string]$NodeExe)

  $nodeDir = Split-Path -Parent $NodeExe
  $adjacentNpm = Join-Path $nodeDir 'npm.cmd'
  if (Test-Path -LiteralPath $adjacentNpm -PathType Leaf) {
    return $adjacentNpm
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }

  throw "npm.cmd was not found next to Node.js: $NodeExe"
}

Set-Location $repoRoot

$nodeExe = Get-ReleaseNode
$npmCmd = Get-NpmCommand -NodeExe $nodeExe
$nodeVersion = (& $nodeExe '--version').Trim()
$nodeDir = Split-Path -Parent $nodeExe
$env:PATH = "$nodeDir;$env:PATH"

Write-Host '[LFClaw Windows Release]' -ForegroundColor Cyan
Write-Host "Repository: $repoRoot"
Write-Host "Node: $nodeVersion ($nodeExe)"
Write-Host 'Version number, changelog, and package validation are handled by npm run release:win.'

if ($CheckOnly) {
  Write-Host 'Environment check passed. No package was built.' -ForegroundColor Green
  exit 0
}

Stop-LFClawDevelopmentProcesses

if (-not (Test-Path -LiteralPath $releaseDir -PathType Container)) {
  New-Item -ItemType Directory -Path $releaseDir | Out-Null
}

Write-Host ''
Write-Host 'Building Windows package. Keep this window open; it can take several minutes.' -ForegroundColor Yellow
& $npmCmd 'run' 'release:win'
if ($LASTEXITCODE -ne 0) {
  throw "release:win failed with exit code: $LASTEXITCODE"
}

$package = Get-ChildItem -LiteralPath $releaseDir -Filter 'LFClaw-Setup-*-win-x64-official.exe' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $package) {
  throw "Windows installer was not found after packaging: $releaseDir"
}

if ($package.BaseName -notmatch 'LFClaw-Setup-(\d{10})-win-x64-official') {
  throw "Installer filename does not follow the release convention: $($package.Name)"
}

$version = $Matches[1]
$changelog = Join-Path $releaseDir "changelog-$version.zh.txt"
if (-not (Test-Path -LiteralPath $changelog -PathType Leaf)) {
  throw "Matching changelog was not found: $changelog"
}

$stream = [System.IO.File]::OpenRead($package.FullName)
try {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
  } finally {
    $sha256.Dispose()
  }
} finally {
  $stream.Dispose()
}
Write-Host ''
Write-Host 'Windows package completed.' -ForegroundColor Green
Write-Host "Version: $version"
Write-Host "Installer: $($package.FullName)"
Write-Host "Changelog: $changelog"
Write-Host "SHA256: $hash"

if (-not $NoOpenFolder) {
  Start-Process explorer.exe $releaseDir
}
