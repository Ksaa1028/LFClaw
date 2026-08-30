'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

function readExpectedRuntime(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = pkg.openclaw?.version;
  if (!version) throw new Error('Pinned OpenClaw version is missing.');
  const patchesDir = path.join(rootDir, 'scripts', 'patches', version);
  // Match build-openclaw-runtime.sh: hash the sorted patch bytes, not file mtimes.
  const hash = createHash('sha256');
  const patches = fs.readdirSync(patchesDir).filter(name => name.endsWith('.patch')).sort();
  for (const name of patches) hash.update(fs.readFileSync(path.join(patchesDir, name)));
  return { version, patchHash: hash.digest('hex') };
}

function assertRuntimeCurrent(rootDir, runtimeRoot, target) {
  const expected = readExpectedRuntime(rootDir);
  const info = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime-build-info.json'), 'utf8'));
  if (info.target !== target || info.openclawVersion !== expected.version || info.patchHash !== expected.patchHash) {
    throw new Error(`[OpenClaw Release] Runtime is stale or targets another platform. Run npm run openclaw:runtime:${target} before packaging.`);
  }
  // Check executable contents as well: metadata alone cannot prove patch success.
  if (expected.version === 'v2026.6.1') {
    const bundle = fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8');
    for (const sentinel of ['failed to reconnect server', 'MCP_CATALOG_RETRY_ON_FAILURE']) {
      if (!bundle.includes(sentinel)) {
        throw new Error(`[OpenClaw Release] Runtime is missing MCP recovery (${sentinel}). Force rebuild before packaging.`);
      }
    }
  }
}

module.exports = { assertRuntimeCurrent, readExpectedRuntime };
