import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const readArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const userId = readArg('--user-id');
const chatId = readArg('--chat-id');
const contentFile = readArg('--content-file');
const dryRun = process.argv.includes('--dry-run');

if ((!userId && !chatId) || (userId && chatId)) {
  throw new Error('Provide exactly one of --user-id or --chat-id.');
}
if (!contentFile) {
  throw new Error('Missing --content-file.');
}

const content = readFileSync(contentFile, 'utf8');
const card = JSON.parse(content);
if (card?.schema !== '2.0') {
  throw new Error('Executive notifications must use a Card 2.0 payload.');
}

const executableName = process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli';
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
const searchPath = (pathKey ? process.env[pathKey] : '') || '';
const command = searchPath
  .split(delimiter)
  .map((directory) => join(directory, executableName))
  .find(existsSync) || executableName;
const receiveIdType = userId ? 'open_id' : 'chat_id';
const endpoint = '/open-apis/im/v1/messages';
const requestBody = {
  receive_id: userId || chatId,
  msg_type: 'interactive',
  content: JSON.stringify(card),
};

const tempRoot = mkdtempSync(join(tmpdir(), 'longfeng-executive-card-'));
const requestFile = join(tempRoot, 'request.json');
const paramsFile = join(tempRoot, 'params.json');
writeFileSync(requestFile, JSON.stringify(requestBody), 'utf8');
writeFileSync(paramsFile, JSON.stringify({ receive_id_type: receiveIdType }), 'utf8');

try {
  const args = [
    'api', 'POST', endpoint,
    '--params', '@params.json',
    '--data', '@request.json',
    '--as', 'bot',
  ];
  if (dryRun) args.push('--dry-run');
  const result = spawnSync(command, args, {
    cwd: tempRoot,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
