[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$NoOpenFolder
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $repoRoot 'release'

function Test-NodeExecutable {
  param([string]$Path)

  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  try {
    $version = & $Path '--version' 2>$null
    return $LASTEXITCODE -eq 0 -and $version -match '^v\d+'
  } catch {
    return $false
  }
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

  throw 'No usable Node.js executable was found. Install Node.js or set LFCLAW_NODE_EXE to node.exe.'
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

$hash = (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash
Write-Host ''
Write-Host 'Windows package completed.' -ForegroundColor Green
Write-Host "Version: $version"
Write-Host "Installer: $($package.FullName)"
Write-Host "Changelog: $changelog"
Write-Host "SHA256: $hash"

if (-not $NoOpenFolder) {
  Start-Process explorer.exe $releaseDir
}
