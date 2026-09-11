import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createOpenVikingGateway,
  isAllowedOpenVikingRoute,
  normalizeOpenViking,
  sanitizeOpenVikingPayload,
} from './openVikingGateway.mjs';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
    this.writableEnded = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk) {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }

  json() {
    return JSON.parse(Buffer.concat(this.chunks).toString('utf8'));
  }
}

const request = ({ method = 'GET', headers = {}, body = '' } = {}) => {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.headers = headers;
  return stream;
};

const runGateway = async ({
  method = 'GET',
  path = '/api/enterprise/openviking/health',
  headers = { 'x-api-key': 'enterprise-token' },
  body = '',
  enabled = true,
  authenticate = token => token === 'enterprise-token' ? { userId: 'u_alice', status: 'active' } : null,
  fetchImpl = async () => new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
  options = {},
} = {}) => {
  const handler = createOpenVikingGateway({
    isEnabled: () => enabled,
    authenticate,
    fetchImpl,
    logger: { warn() {} },
    ...options,
  });
  const req = request({ method, headers, body });
  const res = new MockResponse();
  const handled = await handler(req, res, new URL(path, 'http://localhost'));
  return { handled, req, res };
};

test('route allowlist permits memory lifecycle and blocks client delete/admin operations', () => {
  assert.equal(isAllowedOpenVikingRoute('POST', '/api/v1/search/find'), true);
  assert.equal(isAllowedOpenVikingRoute('POST', '/api/v1/sessions/session-1/messages'), true);
  assert.equal(isAllowedOpenVikingRoute('DELETE', '/api/v1/sessions/session-1'), false);
  assert.equal(isAllowedOpenVikingRoute('GET', '/api/v1/admin/accounts'), false);
  assert.equal(isAllowedOpenVikingRoute('DELETE', '/api/v1/fs'), false);
  assert.equal(isAllowedOpenVikingRoute('GET', '/api/v1/sessions/%2Fadmin'), false);
});

test('partial config updates preserve the existing global switch', () => {
  assert.deepEqual(normalizeOpenViking({}, { enabled: true }), { enabled: true });
  assert.deepEqual(normalizeOpenViking({ enabled: false }, { enabled: true }), { enabled: false });
});

test('sensitive values are redacted recursively before capture', () => {
  const result = sanitizeOpenVikingPayload({
    password: 'very-secret',
    dashscopeApiKey: 'sk-example123456',
    accessToken: 'enterprise-token',
    nested: {
      content: '邮箱 kai@example.com 手机 13800138000 身份证 11010519491231002X API key: sk-example123456',
    },
  });
  assert.equal(result.password, '[REDACTED]');
  assert.equal(result.dashscopeApiKey, '[REDACTED]');
  assert.equal(result.accessToken, '[REDACTED]');
  assert.match(result.nested.content, /\[REDACTED_EMAIL\]/);
  assert.match(result.nested.content, /\[REDACTED_PHONE\]/);
  assert.match(result.nested.content, /\[REDACTED_ID_CARD\]/);
  assert.doesNotMatch(result.nested.content, /sk-example123456/);
});

test('missing enterprise token is rejected without contacting OpenViking', async () => {
  let calls = 0;
  const { res } = await runGateway({
    headers: {},
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(calls, 0);
});

test('disabled memory is rejected before upstream access', async () => {
  let calls = 0;
  const { res } = await runGateway({
    enabled: false,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'memory_disabled');
  assert.equal(calls, 0);
});

test('gateway overwrites client identity and API key with server identity', async () => {
  let received;
  const { res } = await runGateway({
    method: 'POST',
    path: '/api/enterprise/openviking/api/v1/search/find',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'enterprise-token',
      'x-openviking-account': 'forged-account',
      'x-openviking-user': 'forged-user',
      authorization: 'Bearer forged-root',
    },
    body: JSON.stringify({
      query: 'hello',
      target_uri: 'viking://user/memories',
      password: 'hidden',
    }),
    fetchImpl: async (url, init) => {
      received = { url: String(url), init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ status: 'ok', result: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    options: {
      accountId: 'lfclaw',
      upstreamApiKey: 'server-root-key',
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(received.init.headers['x-openviking-account'], 'lfclaw');
  assert.equal(received.init.headers['x-openviking-user'], 'u_alice');
  assert.equal(received.init.headers['x-api-key'], 'server-root-key');
  assert.equal(received.init.headers.authorization, undefined);
  assert.equal(received.body.password, '[REDACTED]');
});

test('search is restricted to the authenticated employee personal memory', async () => {
  let calls = 0;
  const { res } = await runGateway({
    method: 'POST',
    path: '/api/enterprise/openviking/api/v1/search/find',
    headers: { 'content-type': 'application/json', 'x-api-key': 'enterprise-token' },
    body: JSON.stringify({ query: 'shared secret', target_uri: 'viking://resources' }),
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'memory_scope_not_allowed');
  assert.equal(calls, 0);
});

test('client identity selectors in request bodies are rejected', async () => {
  let calls = 0;
  const { res } = await runGateway({
    method: 'POST',
    path: '/api/enterprise/openviking/api/v1/sessions',
    headers: { 'content-type': 'application/json', 'x-api-key': 'enterprise-token' },
    body: JSON.stringify({ session_id: 'session-1', user_id: 'u_bob' }),
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'identity_override_not_allowed');
  assert.equal(calls, 0);
});

test('invalid employee identity never reaches an upstream header', async () => {
  let calls = 0;
  const { res } = await runGateway({
    authenticate: () => ({ userId: 'u_alice\r\nx-forged: yes', status: 'active' }),
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error.code, 'memory_identity_missing');
  assert.equal(calls, 0);
});

test('different enterprise identities remain isolated', async () => {
  const users = [];
  const fetchImpl = async (_url, init) => {
    users.push(init.headers['x-openviking-user']);
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  };
  const authenticate = token => ({ userId: token === 'alice-token' ? 'u_alice' : 'u_bob', status: 'active' });
  await runGateway({ headers: { 'x-api-key': 'alice-token' }, authenticate, fetchImpl });
  await runGateway({ headers: { 'x-api-key': 'bob-token' }, authenticate, fetchImpl });
  assert.deepEqual(users, ['u_alice', 'u_bob']);
});

test('timeout returns 504 and does not throw into the enterprise server', async () => {
  const { res } = await runGateway({
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
    options: { timeoutMs: 500 },
  });
  assert.equal(res.statusCode, 504);
  assert.equal(res.json().error.code, 'memory_timeout');
});

test('oversized request returns 413 before upstream access', async () => {
  let calls = 0;
  const { res } = await runGateway({
    method: 'POST',
    path: '/api/enterprise/openviking/api/v1/search/find',
    headers: { 'content-type': 'application/json', 'x-api-key': 'enterprise-token' },
    body: JSON.stringify({
      query: 'x'.repeat(20_000),
      target_uri: 'viking://user/memories',
    }),
    fetchImpl: async () => {
      calls += 1;
      return new Response('{}');
    },
    options: { maxBodyBytes: 16 * 1024 },
  });
  assert.equal(res.statusCode, 413);
  assert.equal(calls, 0);
});
