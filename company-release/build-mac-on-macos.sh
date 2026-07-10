#!/usr/bin/env bash
set -euo pipefail

# Run this script on a macOS build machine.
# It builds both Intel and Apple Silicon packages, then copies the artifacts
# into company-release/.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT_DIR"

node -e 'const [major, minor]=process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 15)) { console.error(`Node ${process.versions.node} is too old. Require >=24.15 <25`); process.exit(1); }'

CONFIG_FILE="resources/enterprise-config/openclaw-gateway.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Missing enterprise OpenClaw config: $CONFIG_FILE" >&2
  exit 1
fi

node - <<'NODE'
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('resources/enterprise-config/openclaw-gateway.json', 'utf8'));
if (config.mode !== 'remote' || config.gatewayUrl !== 'http://8.216.38.213:18791') {
  console.error('Enterprise OpenClaw config is not pointing to the company gateway.');
  console.error(JSON.stringify(config, null, 2));
  process.exit(1);
}
if (config.token) {
  console.error('Enterprise OpenClaw config must not contain a fixed gateway token.');
  process.exit(1);
}
console.log('Enterprise OpenClaw gateway config OK:', config.gatewayUrl);
NODE

if command -v iconutil >/dev/null 2>&1; then
  bash scripts/regenerate-mac-icon.sh
else
  echo "WARNING: iconutil not found; macOS icon.icns will not be regenerated." >&2
fi

npm run dist:mac:x64
npm run dist:mac:arm64

mkdir -p company-release
find release -maxdepth 1 -type f \( -name '*.dmg' -o -name '*.zip' \) -print -exec cp -f {} company-release/ \;

found_config=0
while IFS= read -r -d '' config_path; do
  echo "Packaged enterprise config found: $config_path"
  if grep -q 'http://8.216.38.213:18791' "$config_path"; then
    found_config=1
  fi
done < <(find release -path '*LfClaw.app/Contents/Resources/enterprise-config/openclaw-gateway.json' -print0 2>/dev/null || true)

if [[ "$found_config" != "1" ]]; then
  echo "WARNING: Could not verify packaged enterprise config inside release/*.app."
  echo "If only dmg artifacts were kept, mount the dmg and verify Contents/Resources/enterprise-config/openclaw-gateway.json points to http://8.216.38.213:18791."
fi

echo "macOS artifacts copied to: $ROOT_DIR/company-release"
