$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $repoRoot
$nodeDir = Join-Path $workspaceRoot '.codex-temp\node\node-v24.18.0-win-x64'
$corepackShims = Join-Path $nodeDir 'node_modules\corepack\shims'
$mingitBin = Join-Path $repoRoot 'resources\mingit\bin'

if (-not (Test-Path -LiteralPath (Join-Path $nodeDir 'node.exe'))) {
  throw "Node 24 runtime not found: $nodeDir"
}

$env:PATH = "$mingitBin;$corepackShims;$nodeDir;$env:PATH"
$env:LOBSTERAI_OPENCLAW_GATEWAY_MODE = 'remote'
$env:LOBSTERAI_OPENCLAW_GATEWAY_URL = 'http://8.216.38.213:18790'
$env:LOBSTERAI_OPENCLAW_MODEL = 'zai/glm-5.2'
$gatewayToken = [Environment]::GetEnvironmentVariable('LOBSTERAI_OPENCLAW_GATEWAY_TOKEN', 'User')
if ($gatewayToken) {
  $env:LOBSTERAI_OPENCLAW_GATEWAY_TOKEN = $gatewayToken
}
$env:OPENCLAW_ALLOW_INSECURE_PRIVATE_WS = '1'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

Write-Host "Node: $(& (Join-Path $nodeDir 'node.exe') -v)"
Write-Host "Gateway mode: $env:LOBSTERAI_OPENCLAW_GATEWAY_MODE"
Write-Host "Gateway URL:  $env:LOBSTERAI_OPENCLAW_GATEWAY_URL"
Write-Host "Gateway token: $(if ($env:LOBSTERAI_OPENCLAW_GATEWAY_TOKEN) { 'set' } else { 'missing' })"
Write-Host "OpenClaw model: $env:LOBSTERAI_OPENCLAW_MODEL"
Write-Host "Allow insecure WS: $env:OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"

Set-Location -LiteralPath $repoRoot
& (Join-Path $nodeDir 'npm.cmd') run electron:dev
