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
});
