#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function log(message) {
  console.log(`[patch-weixin-provider] ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function patchGatewayMethods(channelPath) {
  if (!fs.existsSync(channelPath)) return false;
  let src = fs.readFileSync(channelPath, 'utf8');
  if (src.includes('gatewayMethods')) return false;

  const marker = 'configSchema: {';
  const idx = src.indexOf(marker);
  if (idx === -1) return false;

  src = `${src.slice(0, idx)}gatewayMethods: ["web.login.start", "web.login.wait"],\n  ${src.slice(idx)}`;
  fs.writeFileSync(channelPath, src);
  log(`patched gatewayMethods: ${channelPath}`);
  return true;
}

function patchStartupActivation(manifestPath) {
  if (!fs.existsSync(manifestPath)) return false;
  const manifest = readJson(manifestPath);
  if (!manifest) return false;
  if (manifest.activation?.onStartup === true) return false;

  manifest.activation = {
    ...(manifest.activation && typeof manifest.activation === 'object' ? manifest.activation : {}),
    onStartup: true,
  };
  writeJson(manifestPath, manifest);
  log(`patched startup activation: ${manifestPath}`);
  return true;
}

function patchPluginDir(pluginDir) {
  let changed = false;
  changed = patchGatewayMethods(path.join(pluginDir, 'src', 'channel.ts')) || changed;
  changed = patchGatewayMethods(path.join(pluginDir, 'dist', 'src', 'channel.js')) || changed;
  changed = patchStartupActivation(path.join(pluginDir, 'openclaw.plugin.json')) || changed;
  return changed;
}

function findPluginDirs() {
  const candidates = new Set();
  const explicit = process.argv.slice(2).filter(Boolean);
  for (const item of explicit) candidates.add(path.resolve(item));

  const roots = [
    path.join(os.homedir(), '.openclaw'),
    '/root/.openclaw',
    '/opt',
    '/usr/local/lib',
    '/usr/lib',
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      const output = execFileSync(
        'find',
        [root, '-type', 'd', '-name', 'openclaw-weixin', '-print', '-quit'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (output) candidates.add(output);
    } catch {
      // Ignore roots that cannot be searched.
    }
  }

  return [...candidates].filter((dir) => fs.existsSync(dir));
}

const pluginDirs = findPluginDirs();
if (pluginDirs.length === 0) {
  console.error('No openclaw-weixin plugin directory found. Pass the plugin directory as the first argument.');
  process.exit(1);
}

let changed = false;
for (const pluginDir of pluginDirs) {
  log(`checking ${pluginDir}`);
  changed = patchPluginDir(pluginDir) || changed;
}

log(changed ? 'done. Restart OpenClaw gateway now.' : 'nothing changed. Plugin already looks patched.');
