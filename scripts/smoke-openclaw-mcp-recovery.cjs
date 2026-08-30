'use strict';

// Local-only integration check. Reads the pinned source, applies the MCP
// patches in memory, and runs its runtime with real SDK transports on loopback.
// No edits to the sibling checkout, vendor runtime, or user configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { applyPatch } = require('diff');
const ts = require('typescript');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const { ErrorCode, ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const root = path.resolve(__dirname, '..');
const version = require('../package.json').openclaw.version;
const sourceRoot = process.env.OPENCLAW_SRC || path.resolve(root, '../openclaw');
let code = fs.readFileSync(path.join(sourceRoot, 'src/agents/agent-bundle-mcp-runtime.ts'), 'utf8').replace(/\r/g, '');
for (const [name, sentinel] of [
  ['openclaw-mcp-stale-connection-recovery.patch', 'failed to reconnect server'],
  ['openclaw-mcp-stale-request-backoff.patch', 'MCP_REQUEST_FAILURE_BACKOFF'],
  ['openclaw-mcp-timeout-and-catalog-retry.patch', 'MCP_CATALOG_RETRY_ON_FAILURE'],
]) {
  const patch = fs.readFileSync(path.join(root, 'scripts/patches', version, name), 'utf8').replace(/\r/g, '');
  const applied = applyPatch(code, patch);
  if (applied !== false) code = applied;
  else if (!code.includes(sentinel)) {
    throw new Error(`Cannot apply MCP patch in memory: ${name}`);
  }
}
const names = new Set([
  'createSessionMcpRuntime', 'connectWithTimeout', 'redactErrorUrls', 'listAllTools',
  'isMcpMethodNotFoundError', 'listAllToolsBestEffort', 'hasConfiguredMcpRequestTimeout',
  'getCatalogListTimeoutMs', 'disposeSession', 'summarizeServerCapabilities',
  'sanitizeMcpMetadataText', 'createDisposedError', 'BUNDLE_MCP_FAILURE_THRESHOLD',
  'BUNDLE_MCP_FAILURE_COOLDOWN_MS', 'BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS',
  'BUNDLE_MCP_METADATA_TEXT_LIMIT', 'bundleMcpCatalogListTimeoutMs', 'DISPOSE_TIMEOUT_MS',
]);
const ast = ts.createSourceFile('runtime.ts', code, ts.ScriptTarget.Latest, true);
const selected = ast.statements.filter(node => (
  ts.isFunctionDeclaration(node) && names.has(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.has(d.name.getText(ast)))
));
assert.equal(selected.length, names.size);
const compiled = ts.transpileModule(selected.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const { createRuntime, catalogTimeout } = vm.runInNewContext(`${compiled}; ({ createRuntime: createSessionMcpRuntime, catalogTimeout: getCatalogListTimeoutMs })`, {
  exports: {}, setTimeout, clearTimeout, Client, StreamableHTTPClientTransport, ErrorCode,
  createBundleMcpJsonSchemaValidator: () => new AjvJsonSchemaValidator(),
  loadSessionMcpConfig: ({ cfg }) => ({ loaded: { mcpServers: cfg.mcp.servers }, fingerprint: 'test' }),
  resolveMcpTransport: (_name, config) => ({
    transport: new StreamableHTTPClientTransport(new URL(config.url)),
    transportType: 'streamable-http', description: 'loopback MCP',
    connectionTimeoutMs: 2000, requestTimeoutMs: config.requestTimeoutMs,
  }),
  logWarn: message => console.log(`[MCP smoke] ${message}`),
  sanitizeServerName: name => name,
  getMcpToolSelection: () => ({}), shouldExposeMcpTool: () => true,
  isMcpConfigRecord: value => value !== null && typeof value === 'object',
  normalizeOptionalString: value => value?.trim(),
  redactSensitiveUrlLikeString: value => value,
  toLintErrorObject: error => error,
});
assert.equal(catalogTimeout({}, 60_000), 30_000);
assert.equal(catalogTimeout({ requestTimeoutMs: 180_000 }, 180_000), 30_000);
assert.equal(catalogTimeout({ requestTimeoutMs: 500 }, 500), 500);

async function main() {
  let offline = false;
  let slowCall = false;
  let calls = 0;
  let listDelay = 1800;
  const transports = new Map();
  const servers = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (offline) { res.writeHead(503).end(); return; }
      let body;
      if (req.method === 'POST') {
        let text = '';
        for await (const chunk of req) text += chunk;
        body = JSON.parse(text);
      }
      const id = req.headers['mcp-session-id'];
      let transport = id ? transports.get(id) : undefined;
      if (!transport && id) { res.writeHead(404).end(); return; }
      if (!transport) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: sid => transports.set(sid, transport) });
        const mcp = new Server({ name: 'local-recovery-test', version: '1.0.0' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => {
          await new Promise(resolve => setTimeout(resolve, listDelay));
          return { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] };
        });
        mcp.setRequestHandler(CallToolRequestSchema, async () => {
          calls += 1;
          if (slowCall) await new Promise(resolve => setTimeout(resolve, 2200));
          return { content: [{ type: 'text', text: 'ok' }] };
        });
        servers.push(mcp);
        await mcp.connect(transport);
      }
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = createRuntime({
    sessionId: 'original-session', workspaceDir: root,
    cfg: { mcp: { servers: { local: { url: `http://127.0.0.1:${server.address().port}/mcp`, requestTimeoutMs: 2000 } } } },
  });
  try {
    const catalog = await runtime.getCatalog();
    assert.equal(catalog.tools.length, 1, 'discovery over 1.5 seconds must succeed');
    listDelay = 0;
    await runtime.callTool('local', 'echo', {});
    assert.equal(calls, 1);

    // A server restart invalidates every old server-side session.
    for (const transport of transports.values()) await transport.close();
    transports.clear();
    await assert.rejects(runtime.callTool('local', 'echo', {}));
    assert.equal(calls, 1, 'failed call must not be automatically replayed');
    await runtime.callTool('local', 'echo', {});
    assert.equal(calls, 2, 'next call in the same runtime must recover');

    offline = true;
    await assert.rejects(runtime.callTool('local', 'echo', {}));
    await assert.rejects(runtime.callTool('local', 'echo', {}));
    assert.equal(runtime.peekCatalog(), null, 'failed discovery must not be cached');
    offline = false;
    await runtime.callTool('local', 'echo', {});
    assert.equal(calls, 3, 'offline retries must not poison future discovery');

    slowCall = true;
    await assert.rejects(runtime.callTool('local', 'echo', {}));
    assert.equal(calls, 4, 'timed-out calls with possible side effects must execute only once');
    slowCall = false;
    await runtime.callTool('local', 'echo', {});
    assert.equal(calls, 5);
    assert.equal(runtime.sessionId, 'original-session');
    console.log('[MCP smoke] PASS: slow discovery, server restart, prolonged outage, timeout, no replay, same-session recovery');
  } finally {
    offline = false;
    await runtime.dispose();
    await Promise.allSettled(servers.map(mcp => mcp.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
