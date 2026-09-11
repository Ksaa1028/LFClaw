import crypto from 'crypto';
import http from 'http';

import type { EnterprisePolicy } from '../../shared/enterprise/constants';

export const EnterpriseMcpProxyProtocol = {
  RegistryPrefix: 'enterprise:',
  AssertionHeader: 'x-lfclaw-permission-assertion',
  LocalHeader: 'x-lfclaw-mcp-proxy-secret',
  MessagePath: '/mcp2/message',
  EndpointEvent: 'endpoint',
} as const;

export const toEnterpriseMcpRegistryId = (serverId: string): string => (
  serverId.startsWith(EnterpriseMcpProxyProtocol.RegistryPrefix)
    ? serverId
    : `${EnterpriseMcpProxyProtocol.RegistryPrefix}${serverId}`
);

export const fromEnterpriseMcpRegistryId = (registryId?: string | null): string | null => (
  registryId?.startsWith(EnterpriseMcpProxyProtocol.RegistryPrefix)
    ? registryId.slice(EnterpriseMcpProxyProtocol.RegistryPrefix.length)
    : null
);

type RemoteServer = NonNullable<EnterprisePolicy['mcpServers']>[number];
type Registration = { url: string; resolve: (force: boolean) => Promise<RemoteServer> };
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Per-request credential injection for the enterprise SSE MCP. The gateway sees
 * a stable local URL/header, so rotating a remote credential needs no restart.
 * No grant cache: every POST is authorized against the current enterprise policy.
 */
export class EnterpriseMcpProxy {
  private server: http.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private port = 0;
  private readonly secret = crypto.randomBytes(32).toString('hex');
  private readonly registrations = new Map<string, Registration>();
  private readonly endpoints = new Map<string, { key: string; url: string }>();
  private readonly controllers = new Set<AbortController>();

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handle(req, res).catch(error => {
          const denied = error instanceof Error && error.message === 'MCP_PERMISSION_DENIED';
          if (!res.headersSent) this.fail(res, denied ? 403 : 503, denied ? 'MCP_PERMISSION_DENIED' : 'MCP_PROXY_UNAVAILABLE');
          else res.destroy();
        });
      });
      this.server = server;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address !== 'string') this.port = address.port;
        server.unref();
        resolve();
      });
    }).catch(error => { this.startPromise = null; throw error; });
    return this.startPromise;
  }

  register(id: string, url: string, identity: string, resolve: Registration['resolve']): { url: string; headers: Record<string, string> } {
    if (!this.port) throw new Error('Enterprise MCP proxy is not listening');
    const key = crypto.createHash('sha256').update(JSON.stringify([id, url, identity])).digest('hex');
    this.registrations.set(key, { url, resolve });
    return {
      url: `http://127.0.0.1:${this.port}/${key}/sse`,
      headers: { [EnterpriseMcpProxyProtocol.LocalHeader]: this.secret },
    };
  }

  async stop(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    this.endpoints.clear();
    this.registrations.clear();
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.startPromise = null;
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private fail(res: http.ServerResponse, status: number, code: string): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: code }));
  }

  private async resolve(registration: Registration, force: boolean): Promise<RemoteServer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = await Promise.race([
        registration.resolve(force),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP_POLICY_TIMEOUT')), AUTH_TIMEOUT_MS); }),
      ]);
      if (current.url !== registration.url || !current.permissions?.length) throw new Error('MCP_PERMISSION_DENIED');
      if (!current.headers?.[EnterpriseMcpProxyProtocol.AssertionHeader]) throw new Error('MCP_ASSERTION_MISSING');
      return current;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const auth = req.headers[EnterpriseMcpProxyProtocol.LocalHeader];
    if (typeof auth !== 'string' || auth.length !== this.secret.length
      || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(this.secret))) {
      this.fail(res, 401, 'MCP_PROXY_UNAUTHORIZED'); return;
    }
    const parts = new URL(req.url || '/', 'http://localhost').pathname.split('/');
    const key = parts[1];
    const registration = this.registrations.get(key);
    if (!registration) { this.fail(res, 404, 'MCP_PROXY_UNKNOWN_SERVER'); return; }
    const isStream = req.method === 'GET' && parts[2] === 'sse';
    const endpoint = this.endpoints.get(parts[3]);
    if (!isStream && !(req.method === 'POST' && parts[2] === 'message' && endpoint?.key === key)) {
      this.fail(res, 404, 'MCP_PROXY_UNKNOWN_SESSION'); return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    res.once('close', () => controller.abort());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (!isStream) {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) { this.fail(res, 413, 'MCP_PROXY_REQUEST_TOO_LARGE'); return; }
          chunks.push(Buffer.from(chunk));
        }
      }
      const body = isStream ? undefined : Buffer.concat(chunks);
      const send = (server: RemoteServer) => fetch(isStream ? registration.url : endpoint!.url, {
        method: isStream ? 'GET' : 'POST',
        headers: { ...server.headers, accept: isStream ? 'text/event-stream' : 'application/json', ...(isStream ? {} : { 'content-type': 'application/json' }) },
        body, signal: controller.signal, redirect: 'manual',
      });
      let current = await this.resolve(registration, false);
      // Normally /me already renews five minutes early. Also guard against an
      // older enterprise service or a stale cached response before sending POST.
      let expiresAt = Number.POSITIVE_INFINITY;
      try {
        const payload = JSON.parse(Buffer.from(current.headers![EnterpriseMcpProxyProtocol.AssertionHeader].split('.')[0], 'base64url').toString('utf8'));
        if (typeof payload.exp === 'number') expiresAt = payload.exp * 1000;
      } catch {
        // Non-decodable credentials are handled by the authoritative MCP verifier.
      }
      if (expiresAt <= Date.now() + 60_000) current = await this.resolve(registration, true);
      timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let upstream = await send(current);
      // lf-mcp-server2 rejects 401 BEFORE parsing/dispatching tools/call. Only
      // this known endpoint is eligible, never generic remote MCP mutations.
      if (!isStream && upstream.status === 401) {
        await upstream.body?.cancel();
        current = await this.resolve(registration, true);
        upstream = await send(current);
      }
      if (!isStream && upstream.status === 401) {
        await upstream.body?.cancel();
        console.warn('[EnterpriseMCP] Upstream rejected permission assertion after forced refresh; check MCP server LFCLAW_MCP_PERMISSION_SECRET and LFCLAW_MCP_ID.');
        this.fail(res, 403, 'MCP_AUTH_FAILED_AFTER_REFRESH'); return;
      }
      if (isStream && upstream.ok) {
        clearTimeout(timer);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.flushHeaders();
        await this.pipeEvents(upstream, res, key, registration.url);
      } else {
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.controllers.delete(controller);
    }
  }

  private async pipeEvents(upstream: Response, res: http.ServerResponse, key: string, remoteUrl: string): Promise<void> {
    if (!upstream.body) throw new Error('MCP stream has no body');
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const endpointIds: string[] = [];
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          let event = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          if (/^event:\s*endpoint\s*$/m.test(event)) {
            const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            const target = new URL(data, remoteUrl);
            const base = new URL(remoteUrl);
            if (target.origin !== base.origin || target.pathname !== EnterpriseMcpProxyProtocol.MessagePath || target.username || target.password) {
              throw new Error('MCP endpoint escaped configured server');
            }
            const id = crypto.randomUUID();
            endpointIds.push(id);
            this.endpoints.set(id, { key, url: target.href });
            event = `event: ${EnterpriseMcpProxyProtocol.EndpointEvent}\ndata: http://127.0.0.1:${this.port}/${key}/message/${id}`;
          }
          res.write(`${event}\n\n`);
        }
        if (pending.length > MAX_BODY_BYTES) throw new Error('MCP event is too large');
      }
      res.end();
    } finally {
      for (const id of endpointIds) this.endpoints.delete(id);
      await reader.cancel().catch((): void => undefined);
    }
  }
}
