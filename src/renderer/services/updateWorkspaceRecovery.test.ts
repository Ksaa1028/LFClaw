import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getState: vi.fn(),
}));

vi.mock('../store', () => ({ store: mocks }));
vi.mock('./i18n', () => ({ i18nService: { t: (key: string) => key } }));

import { installUpdateWithWorkspace,restoreUpdateWorkspace } from './updateWorkspaceRecovery';

const drafts = {
  draftPrompts: { 'session-1': 'unfinished prompt' },
  draftAttachments: {},
  draftSelectedTextSnippets: {},
  draftKitIds: {},
  draftSkillIds: {},
  draftCollaborationModes: {},
  steerDrafts: {},
};

describe('update workspace recovery', () => {
  const values = new Map<string, unknown>();
  const remove = vi.fn(async (key: string) => { values.delete(key); });
  const installReady = vi.fn();

  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
    mocks.getState.mockReturnValue({ cowork: { ...drafts, currentSessionId: 'session-1' } });
    installReady.mockResolvedValue({ success: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.assign(new EventTarget(), {
        electron: {
          enterprise: { getStatus: vi.fn(async () => ({ success: true, status: { access: { user: { userId: 'owner-1' } } } })) },
          store: {
            get: vi.fn(async (key: string) => values.get(key)),
            set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
            remove,
          },
          appUpdate: { installReady },
        },
      }),
    });
  });

  test('saves only drafts and the active session, then restores them once', async () => {
    expect((await installUpdateWithWorkspace()).success).toBe(true);
    expect(values.size).toBe(1);

    const loadSession = vi.fn(async () => undefined);
    await restoreUpdateWorkspace(loadSession);

    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(mocks.dispatch.mock.calls[0][0].payload).toEqual(drafts);
    expect(loadSession).toHaveBeenCalledWith('session-1');
    expect(values.size).toBe(0);
  });

  test('removes the recovery marker when the installer does not start', async () => {
    installReady.mockResolvedValue({ success: false, error: 'cancelled' });
    const result = await installUpdateWithWorkspace();
    expect(result).toEqual({ success: false, error: 'cancelled' });
    expect(remove).toHaveBeenCalledOnce();
    expect(values.size).toBe(0);
  });
});
