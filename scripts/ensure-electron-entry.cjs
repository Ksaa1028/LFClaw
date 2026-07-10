const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'dist-electron', 'main.js');
const ready = path.join(root, 'dist-electron', '.electron-ready');
const compiledMain = path.join(root, 'dist-electron', 'main', 'main.js');

if (fs.existsSync(entry)) {
  fs.writeFileSync(ready, '', 'utf8');
  process.exit(0);
}

if (!fs.existsSync(compiledMain)) {
  console.error(`[electron-entry] missing ${path.relative(root, compiledMain)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.writeFileSync(
  entry,
  [
    "'use strict';",
    "require('./main/main.js');",
    '',
  ].join('\n'),
  'utf8',
);
fs.writeFileSync(ready, '', 'utf8');

console.log('[electron-entry] created dist-electron/main.js and .electron-ready for development startup');
