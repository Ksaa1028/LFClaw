import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

import type { EnterpriseCurrentAccess } from '../shared/enterprise/constants';

// Exercise the actual scoped main-process functions without loading Electron or
// booting the app. AST selection avoids depending on formatting or line numbers.
const source = ts.createSourceFile(
  'main.ts', fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8'), ts.ScriptTarget.Latest, true,
);
function loadFunction<T>(name: string, dependencies: Record<string, unknown> = {}): T {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!initializer) throw new Error(`Missing main-process function: ${name}`);
  const compiled = ts.transpileModule(`(${initializer.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return vm.runInNewContext(compiled, { t: (key: string) => key, ...dependencies }) as T;
}

const access = {
  policy: { modelProviders: [
    { id: 'provider-a', models: [{ id: 'model-a' }] },
    { id: 'provider-b', models: [{ id: 'model-b' }] },
  ] },
  quota: { creditsRemaining: 10 },
} as EnterpriseCurrentAccess;
const resolveModel = loadFunction<(access: EnterpriseCurrentAccess | null, ref?: string) => string | undefined>(
  'resolveEnterpriseModelRef',
);
const resolveContinuationModels = loadFunction<(
  access: EnterpriseCurrentAccess | null,
  sessionModelRef?: string,
  agentModelRef?: string,
) => { sessionModel?: string; agentModel?: string; effectiveModel?: string }>(
  'resolveEnterpriseContinuationModels',
  { resolveEnterpriseModelRef: resolveModel },
);

test('old and new conversations resolve to the same model after provider slots move', () => {
  expect(resolveModel(access, 'custom_1/model-a')).toBe('custom_0/model-a');
  expect(resolveModel(access, 'model-a')).toBe('custom_0/model-a');
  expect(resolveModel(access, 'custom_9/model-b')).toBe('custom_1/model-b');
});
test('preserves a valid selection and supports qualified provider/model IDs', () => {
  expect(resolveModel(access, 'custom_1/model-b')).toBe('custom_1/model-b');
  expect(resolveModel(access, 'provider-b/model-b')).toBe('custom_1/model-b');
  expect(resolveModel(access, '')).toBeUndefined();
  expect(resolveModel(null, ' custom_1/model-b ')).toBe('custom_1/model-b');
});
test('rejects removed and ambiguous selections instead of sending to a stale provider', () => {
  expect(() => resolveModel(access, 'custom_7/removed')).toThrow('coworkErrorModelAccessDenied');
  const duplicate = structuredClone(access);
  duplicate.policy.modelProviders[1].models = [{ id: 'model-a' }];
  expect(() => resolveModel(duplicate, 'custom_9/model-a')).toThrow('coworkErrorModelAccessDenied');
  expect(() => resolveModel(duplicate, 'model-a')).toThrow('coworkErrorModelAccessDenied');
  expect(resolveModel(duplicate, 'custom_1/model-a')).toBe('custom_1/model-a');
});

test('continuation remaps the agent model when a shared session has no model override', () => {
  expect(resolveContinuationModels(access, '', 'custom_1/model-a')).toEqual({
    sessionModel: undefined,
    agentModel: 'custom_0/model-a',
    effectiveModel: 'custom_0/model-a',
  });
});

test('continuation keeps an explicit session model ahead of the agent default', () => {
  expect(resolveContinuationModels(access, 'custom_1/model-b', 'custom_1/model-a')).toEqual({
    sessionModel: 'custom_1/model-b',
    agentModel: undefined,
    effectiveModel: 'custom_1/model-b',
  });
});

function preflight(syncResult: { success: boolean }, pending: unknown = null) {
  const enterpriseAccess = { requireActiveAccess: vi.fn().mockResolvedValue(access) };
  const sync = vi.fn().mockResolvedValue(syncResult);
  const wait = vi.fn().mockResolvedValue(pending);
  const notify = vi.fn();
  const run = loadFunction<() => Promise<unknown>>('ensureEnterpriseAccessForCowork', {
    getLFClawEnterpriseAccess: () => enterpriseAccess,
    syncEnterpriseModelProvidersToAppConfig: vi.fn(),
    syncEnterpriseMcpServersToLocalStore: vi.fn(),
    syncEnterpriseSkillsToLocalStore: vi.fn().mockResolvedValue(undefined),
    syncOpenClawConfig: sync,
    waitForOpenClawConfigApply: wait,
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: notify } }] },
    console: { error: vi.fn(), warn: vi.fn() },
  });
  return { run, sync, wait, notify, enterpriseAccess };
}

test('failed configuration application stops sending rather than using old credentials', async () => {
  const { run, notify, wait } = preflight({ success: false });
  await expect(run()).rejects.toThrow('coworkErrorServerError');
  expect(notify).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
});
test('rejected configuration application is not swallowed', async () => {
  const { run, sync } = preflight({ success: true });
  sync.mockRejectedValue(new Error('config write failed'));
  await expect(run()).rejects.toThrow('config write failed');
});
test('deferred credential restart blocks the turn until a same-session retry is ready', async () => {
  const { run, wait, notify, enterpriseAccess } = preflight({ success: true }, { phase: 'starting' });
  await expect(run()).rejects.toThrow('coworkErrorServiceRestart');
  expect(notify).not.toHaveBeenCalled();
  wait.mockResolvedValue(null);
  await expect(run()).resolves.toBe(enterpriseAccess);
  expect(notify).toHaveBeenCalledOnce();
});
