import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test } from 'vitest';

import { McpTimeout } from '../../shared/mcp/constants';
import type { ResolvedMcpServer } from './openclawConfigSync';

test.each(['stdio', 'sse', 'http'] as const)('syncs bounded timeouts for %s MCP servers', transportType => {
  const source = ts.createSourceFile('config.ts', fs.readFileSync(path.join(__dirname, 'openclawConfigSync.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const names = ['buildOpenClawMcpServers', 'safeServerKey', 'lowercaseHeaderKeys'];
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ''));
  expect(functions).toHaveLength(names.length);
  const code = ts.transpileModule(functions.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const build = vm.runInNewContext(`${code}; buildOpenClawMcpServers`, {
    McpTimeout, createHash: crypto.createHash, MCP_NAME_NON_ASCII_RE: /[^\x00-\x7F]/,
    normalizeMcpServerUrlInput: (url: string) => ({ ok: true, url }),
  }) as (servers: ResolvedMcpServer[]) => Record<string, Record<string, unknown>>;
  const result = build([{ name: 'test', transportType, url: 'http://127.0.0.1/mcp', command: 'test-command', headers: { Authorization: 'test' } }]);
  expect(result.test).toMatchObject({ connectionTimeoutMs: McpTimeout.ConnectionMs, requestTimeoutMs: McpTimeout.RequestMs });
  if (transportType !== 'stdio') expect(result.test.headers).toEqual({ authorization: 'test' });
});
