import http from 'http';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { EnterpriseMcpProxy, EnterpriseMcpProxyProtocol as P } from './enterpriseMcpProxy';

const cleanup: Array<() => Promise<void>> = [];
const TEST_MCP_ID = 'analytics-mcp';
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const calls: Array<{ header: string | string[] | undefined; body: string }> = [];
  let status = 200;
  let rejectOld = false;
  let advertisedEndpoint = '/mcp2/message?sessionId=test';
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Exercise chunked CRLF event parsing, not just one-buffer LF framing.
      res.write('event: end');
      res.write(`point\r\ndata: ${advertisedEndpoint}\r\n\r\n`);
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const header = req.headers[P.AssertionHeader];
    calls.push({ header, body });
    res.writeHead(rejectOld && header === 'old-token' ? 401 : status);
    res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address() as { port: number };
  const remote = { id: TEST_MCP_ID, name: 'enterprise', transportType: 'sse' as const, url: `http://127.0.0.1:${address.port}/sse2`, headers: { [P.AssertionHeader]: 'old-token' }, permissions: [{ id: 'floor2', name: 'floor2' }] };
  const resolve = vi.fn(async (force: boolean) => {
    if (force) remote.headers[P.AssertionHeader] = 'new-token';
    return { ...remote, headers: { ...remote.headers } };
  });
  const proxy = new EnterpriseMcpProxy();
  await proxy.start();
  cleanup.push(() => proxy.stop());
  const local = proxy.register(TEST_MCP_ID, remote.url, 'employee-session', resolve);
  const connect = async () => {
    const stream = await fetch(local.url, { headers: local.headers });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    let data = '';
    while (!data.includes('\n\n')) {
      const result = await reader.read();
      if (result.done) throw new Error('Missing endpoint');
      data += new TextDecoder().decode(result.value);
    }
    const endpoint = /data: (.+)/.exec(data)![1];
    return (body = '{"method":"tools/call","params":{"name":"read"}}') => fetch(endpoint, { method: 'POST', headers: local.headers, body });
  };
  return { proxy, local, remote, resolve, calls, connect, setStatus: (value: number) => { status = value; }, rejectOld: () => { rejectOld = true; }, advertise: (value: string) => { advertisedEndpoint = value; } };
}

describe('Enterprise MCP per-request authorization', () => {
  test('keeps one SSE connection while applying updated headers on the next POST', async () => {
    const f = await fixture();
    const post = await f.connect();
    expect((await post()).status).toBe(200);
    f.remote.headers[P.AssertionHeader] = 'floor1-token';
    expect((await post()).status).toBe(200);
    expect(f.calls.map(call => call.header)).toEqual(['old-token', 'floor1-token']);
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.proxy.register(TEST_MCP_ID, f.remote.url, 'employee-session', f.resolve)).toEqual(f.local);
  });

  test('forces refresh after pre-dispatch 401 and retries the identical request once', async () => {
    const f = await fixture(); f.rejectOld();
    const post = await f.connect();
    const body = '{"method":"tools/call","params":{"name":"write","arguments":{"x":1}}}';
    expect((await post(body)).status).toBe(200);
    expect(f.calls).toEqual([{ header: 'old-token', body }, { header: 'new-token', body }]);
    expect(f.resolve.mock.calls.filter(([force]) => force)).toHaveLength(1);
  });

  test('does not retry permission denials or transport/server failures', async () => {
    const f = await fixture(); const post = await f.connect();
    f.setStatus(403);
    expect((await post()).status).toBe(403);
    f.setStatus(500);
    expect((await post()).status).toBe(500);
    expect(f.calls).toHaveLength(2);
    expect(f.resolve.mock.calls.some(([force]) => force)).toBe(false);
  });

  test('never loops when newly signed credentials are also rejected', async () => {
    const f = await fixture(); const post = await f.connect(); f.setStatus(401);
    expect((await post()).status).toBe(403);
    expect(f.calls).toHaveLength(2);
  });

  test('still retries once when an old enterprise server returns the same credential', async () => {
    const f = await fixture(); const post = await f.connect(); f.rejectOld();
    f.resolve.mockImplementation(async () => f.remote);
    const response = await post();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'MCP_AUTH_FAILED_AFTER_REFRESH' });
    expect(f.calls).toHaveLength(2);
  });

  test('floor revocation and policy unavailability never forward a stale request', async () => {
    const f = await fixture(); const post = await f.connect();
    f.remote.permissions = [];
    expect((await post()).status).toBe(403);
    f.resolve.mockRejectedValue(new Error('Enterprise unavailable'));
    expect((await post()).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });

  test('requires a local secret and isolates registrations across employee sessions', async () => {
    const f = await fixture();
    expect((await fetch(f.local.url)).status).toBe(401);
    expect(f.proxy.register(TEST_MCP_ID, f.remote.url, 'another-employee', f.resolve).url).not.toBe(f.local.url);
    expect(f.resolve).not.toHaveBeenCalled();
  });

  test('rejects SSE message endpoints on a different origin', async () => {
    const f = await fixture(); f.advertise('http://127.0.0.1:1/mcp2/message');
    await expect(f.connect()).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
});
