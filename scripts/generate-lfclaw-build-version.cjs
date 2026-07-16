'use strict';

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', '.lfclaw-build');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'build-version.json');
const VERSION_PATTERN = /^\d{10}$/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function todaySerialPrefix() {
  const now = new Date();
  return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
}

function normalizeSequence(value) {
  const parsed = Number.parseInt(String(value || '1'), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 99) {
    throw new Error('LFCLAW_BUILD_SEQ must be a number between 1 and 99.');
  }
  return pad2(parsed);
}

function resolveBuildVersion() {
  const explicit = process.env.LFCLAW_BUILD_VERSION?.trim();
  if (explicit) {
    if (!VERSION_PATTERN.test(explicit)) {
      throw new Error('LFCLAW_BUILD_VERSION must use YYYYMMDDNN, for example 2026071501.');
    }
    return explicit;
  }

  return `${todaySerialPrefix()}${normalizeSequence(process.env.LFCLAW_BUILD_SEQ)}`;
}

const version = resolveBuildVersion();
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(
  OUTPUT_FILE,
  `${JSON.stringify(
    {
      version,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`[LfClaw Build] build version: ${version}`);
