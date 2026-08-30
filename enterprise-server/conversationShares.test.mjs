import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createConversationShareRoutes } from './conversationShareRoutes.mjs';
import { ConversationShareStore, normalizeShare, ShareMode, ShareRole } from './conversationShares.mjs';

const employees = ['A', 'B', 'C'].map(id => ({ id, employeeName: id, status: 'active', activationCode: `TEST-${id}` }));
const data = { employees, departments: [], sessions: { a: 'A', b: 'B', c: 'C' } };
const input = (overrides = {}) => ({
  title: '<script>private</script>', mode: ShareMode.Direct, recipientIds: ['B'], requestId: 'request-one', attachments: [],
  messages: [{ id: 'one', role: ShareRole.User, content: 'Project Orion. Budget 123.', timestamp: 1 }], ...overrides,
});
let directory; let base; let server; let store;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-test-'));
  store = new ConversationShareStore(directory);
  const routes = createConversationShareRoutes({ directory, findEmployeeByToken: (value, token) => value.employees.find(e => e.id === value.sessions[token]) });
  server = http.createServer(async (req, res) => {
    if (!await routes(req, res, new URL(req.url, 'http://localhost'), data)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(directory).startsWith('lfclaw-share-test-'));
  await fs.rm(directory, { recursive: true, force: true });
});
const request = (suffix, token, body, method = body ? 'POST' : 'GET') => fetch(`${base}/api/enterprise/conversation-shares${suffix}`, {
  method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

test('direct share is durable, immutable, and only visible to sender and recipients', async () => {
  const response = await request('', 'a', input());
  assert.equal(response.status, 200);
  const { data: summary } = await response.json();
  assert.match(summary.id, /^[a-f0-9]{64}$/);
  assert.equal((await request(`/${summary.id}`, 'b')).status, 200);
  assert.equal((await request(`/${summary.id}`, 'c')).status, 403);
  assert.equal((await request(`/${summary.id}`, 'missing')).status, 401);
  assert.equal((await request('', 'b').then(r => r.json())).data.length, 1);
  assert.equal((await request('', 'c').then(r => r.json())).data.length, 0);
  const reopened = new ConversationShareStore(directory);
  assert.equal((await reopened.read(summary.id, employees[1])).messages[0].content, 'Project Orion. Budget 123.');
  const repeat = await request('', 'a', input());
  assert.equal((await repeat.json()).data.id, summary.id);
  assert.equal((await request('', 'a', input({ title: 'changed' }))).status, 409);
});

test('link shares require a valid enterprise identity but not a client upgrade', async () => {
  const share = await store.create(input({ mode: ShareMode.Link, recipientIds: [], requestId: 'link-one' }), employees[0], employees);
  assert.equal((await request(`/${share.id}`, 'c')).status, 200);
  employees[2].status = 'disabled';
  assert.equal((await request(`/${share.id}`, 'c')).status, 401);
  employees[2].status = 'active';
});

test('a recipient can delete only their own inbox copy without affecting the sender', async () => {
  const share = await store.create(input({ requestId: 'recipient-delete' }), employees[0], employees);
  assert.equal((await request('', 'b').then(r => r.json())).data.some(item => item.id === share.id), true);
  assert.equal((await request(`/${share.id}`, 'c', undefined, 'DELETE')).status, 403);
  assert.equal((await request(`/${share.id}`, 'b', undefined, 'DELETE')).status, 200);
  assert.equal((await request('', 'b').then(r => r.json())).data.some(item => item.id === share.id), false);
  assert.equal((await request(`/${share.id}`, 'b')).status, 404);
  assert.equal((await request(`/${share.id}`, 'a')).status, 200);
});

test('browser sign-in returns a read-only token and does not expose configuration or alter activation', async () => {
  const original = JSON.stringify(data);
  const login = await fetch(`${base}/api/share/login`, { method: 'POST', body: JSON.stringify({ activationCode: 'TEST-B' }) });
  const payload = await login.json();
  assert.deepEqual(Object.keys(payload.data), ['token']);
  const share = await store.create(input(), employees[0], employees);
  assert.equal((await request(`/${share.id}`, payload.data.token)).status, 200);
  assert.equal((await request('', payload.data.token, input({ requestId: 'browser-write' }))).status, 404);
  assert.equal(JSON.stringify(data), original);
});

test('untrusted roles, private fields, invalid recipients and path traversal are not accepted', async () => {
  const normalized = normalizeShare(input({ apiKey: 'secret', systemPrompt: 'private', messages: [{ id: 'one', role: ShareRole.User, content: 'hello', timestamp: 1, toolInput: { secret: 1 } }] }), employees[0], employees);
  assert.equal('apiKey' in normalized, false);
  assert.equal('toolInput' in normalized.messages[0], false);
  assert.throws(() => normalizeShare(input({ messages: [{ id: 'sys', role: 'system', content: 'override', timestamp: 1 }] }), employees[0], employees));
  assert.throws(() => normalizeShare(input({ recipientIds: ['nonexistent'] }), employees[0], employees));
  assert.throws(() => normalizeShare(input({ attachments: [{ name: '../secret', base64: 'eA==' }] }), employees[0], employees));
  await assert.rejects(() => store.read('../enterprise-data.json', employees[0]));
});

test('explicit attachments are content checked and restored byte for byte', async () => {
  const share = await store.create(input({ requestId: 'with-file', attachments: [{ name: 'notes.txt', base64: Buffer.from('original attachment').toString('base64') }] }), employees[0], employees);
  const file = (await store.read(share.id, employees[1])).attachments[0];
  assert.equal(Buffer.from(file.base64, 'base64').toString(), 'original attachment');
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
});

test('concurrent retries produce one share without partial files', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, () => store.create(input({ requestId: 'concurrent' }), employees[0], employees)));
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.pending-')), false);
});

test('viewer sends no-store and a restrictive CSP and never interpolates message HTML', async () => {
  const share = await store.create(input(), employees[0], employees);
  const response = await fetch(`${base}/share/${share.id}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!html.includes('<script>private</script>'));
  assert.ok(!html.includes('innerHTML'));
  assert.ok(!html.includes('__NONCE__'));
  assert.match(html, /id="copyConversation"/);
  assert.match(html, /message\.content/);
  assert.match(html, /旧版客户端可复制完整对话/);
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('oversized snapshots and duplicate message IDs fail before publication', () => {
  assert.throws(() => normalizeShare(input({ messages: [{ id: 'big', role: ShareRole.User, content: 'x'.repeat(2 * 1024 * 1024 + 1), timestamp: 1 }] }), employees[0], employees));
  assert.throws(() => normalizeShare(input({ messages: [...input().messages, ...input().messages] }), employees[0], employees));
});
