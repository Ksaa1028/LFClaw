import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
vi.mock('./enterpriseHttpClient', () => ({ fetchEnterprise: vi.fn() }));

import type { SqliteStore } from '../sqliteStore';
import { fetchEnterprise } from './enterpriseHttpClient';
import { LFClawEnterpriseAccess } from './lfclawEnterpriseAccess';

const fetchMock = vi.mocked(fetchEnterprise);
beforeEach(() => { fetchMock.mockReset(); });

function fixture() {
  const data = new Map<string, unknown>([['lfclaw_enterprise_access', {
    serverUrl: 'http://localhost:8787', accessToken: 'session-a', activationCode: 'TEST',
    user: { userId: 'staff', yid: 'staff', status: 1 }, policy: {}, quota: {},
  }]]);
  const store = { get: (key: string) => data.get(key), set: (key: string, value: unknown) => data.set(key, value), delete: (key: string) => data.delete(key) };
  const access = new LFClawEnterpriseAccess(store as unknown as SqliteStore, () => 'test');
  return { access, data };
}
const response = () => new Response(JSON.stringify({ code: 0, data: { policy: { mcpServers: [] } } }));

describe('enterprise policy synchronization', () => {
  test('coalesces concurrent normal synchronizations', async () => {
    const { access } = fixture();
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = access.syncPolicy(); const second = access.syncPolicy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(response());
    await Promise.all([first, second]);
  });

  test('force-refresh waits for a normal sync then requests a new credential without concurrent stale overwrite', async () => {
    const { access } = fixture();
    let finish!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementation(async () => response());
    const normal = access.syncPolicy();
    const forced = access.syncPolicy('dz2.0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(response());
    await Promise.all([normal, forced]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('forceMcpRefresh=dz2.0');
  });

  test('coalesces concurrent forced refreshes for the same MCP', async () => {
    const { access } = fixture();
    fetchMock.mockImplementation(async () => response());
    await Promise.all([access.syncPolicy('dz2.0'), access.syncPolicy('dz2.0')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not restore credentials after logout while a request was in flight', async () => {
    const { access, data } = fixture();
    let finish!: (value: Response) => void;
    fetchMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = access.syncPolicy();
    access.deactivateCurrent();
    finish(response());
    await expect(pending).rejects.toThrow('identity changed');
    expect(data.has('lfclaw_enterprise_access')).toBe(false);
  });

  test('migrates legacy activation identity before syncing current enterprise policy', async () => {
    const data = new Map<string, unknown>([
      ['enterprise_config', {
        activation: { managerUrl: 'http://enterprise.example' },
      }],
      ['enterprise_activation_identity', {
        activationToken: 'legacy-session-token',
        activationCode: 'legacy-code',
        userId: 'u_legacy',
        displayName: 'Legacy User',
        activatedAt: '2026-01-01T00:00:00.000Z',
      }],
    ]);
    const store = {
      get: (key: string) => data.get(key),
      set: (key: string, value: unknown) => data.set(key, value),
      delete: (key: string) => data.delete(key),
    };
    const access = new LFClawEnterpriseAccess(store as unknown as SqliteStore, () => 'test');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      code: 0,
      data: {
        user: { userId: 'u_legacy', nickname: 'Legacy User', status: 1 },
        policy: {
          mcpServers: [{
            id: 'dz2.0',
            name: '兜知2.0',
            transportType: 'sse',
            url: 'https://dzht.nmglfjt.com/sse2',
          }],
        },
      },
    })));

    const synced = await access.syncPolicy();

    expect(fetchMock.mock.calls[0][0]).toContain('http://enterprise.example/api/enterprise/me');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer legacy-session-token',
    });
    expect(synced?.activationCode).toBe('LEGACY-CODE');
    expect(synced?.policy.mcpServers?.[0]).toMatchObject({
      id: 'dz2.0',
      name: '兜知2.0',
    });
    expect(data.get('lfclaw_enterprise_last_activation_code')).toBe('LEGACY-CODE');
  });

  test('migrates legacy activation identity when enterprise access singleton is created', () => {
    const data = new Map<string, unknown>([
      ['enterprise_config', {
        activation: { managerUrl: 'http://enterprise.example' },
      }],
      ['enterprise_activation_identity', {
        activationToken: 'legacy-session-token',
        activationCode: 'legacy-code',
        userId: 'u_legacy',
      }],
    ]);
    const store = {
      get: (key: string) => data.get(key),
      set: (key: string, value: unknown) => data.set(key, value),
      delete: (key: string) => data.delete(key),
    };

    new LFClawEnterpriseAccess(store as unknown as SqliteStore, () => 'test');

    expect(data.get('lfclaw_enterprise_access')).toMatchObject({
      accessToken: 'legacy-session-token',
      activationCode: 'LEGACY-CODE',
      serverUrl: 'http://enterprise.example',
      user: { userId: 'u_legacy' },
    });
    expect(data.get('lfclaw_enterprise_last_activation_code')).toBe('LEGACY-CODE');
  });
});
