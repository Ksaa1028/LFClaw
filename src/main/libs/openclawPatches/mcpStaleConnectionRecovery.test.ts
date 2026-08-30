import { describe, test } from 'vitest';

import { expectPatchContains } from './patchTestUtils';

describe('openclaw-mcp-stale-connection-recovery.patch', () => {
  test('recreates a stale MCP transport without replaying the failed tool request', () => {
    expectPatchContains('openclaw-mcp-stale-connection-recovery.patch', [
      'const recovered = await recoverServerConnection(serverName);',
      'await disposeSession(staleSession);',
      'await getCatalog();',
      'Do not replay this request because MCP tools may',
      'catalog = null;',
    ]);
  });

  test('bounds discovery separately and does not cache a failed catalog', () => {
    expectPatchContains('openclaw-mcp-timeout-and-catalog-retry.patch', [
      'BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 30_000',
      'Math.min(requestTimeoutMs, BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS)',
      'catalog = nextCatalog.diagnostics?.length ? null : nextCatalog;',
      'MCP_CATALOG_RETRY_ON_FAILURE',
    ]);
  });

  test('preserves repeated-request failure protection while reconnecting', () => {
    expectPatchContains('openclaw-mcp-stale-request-backoff.patch', [
      'MCP_REQUEST_FAILURE_BACKOFF',
      '+      recordServerToolFailure(serverName, nowMs);',
      '+    if (!recovered) {',
    ]);
  });
});
