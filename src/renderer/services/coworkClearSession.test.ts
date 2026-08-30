import { beforeEach, describe, expect, test, vi } from 'vitest';

import { store } from '../store';
import { setAgents, setCurrentAgentId } from '../store/slices/agentSlice';
import { setCurrentSession, setSessions } from '../store/slices/coworkSlice';
import { clearActiveSkills, setActiveSkillIds } from '../store/slices/skillSlice';
import { type CoworkSession,CoworkSessionStatusValue } from '../types/cowork';
import { coworkService } from './cowork';

const makeSession = (): CoworkSession => ({
  id: 'session-1',
  title: 'Session 1',
  claudeSessionId: null,
  status: CoworkSessionStatusValue.Running,
  pinned: false,
  pinOrder: null,
  cwd: '/tmp',
  systemPrompt: '',
  modelOverride: '',
  executionMode: 'local',
  activeSkillIds: [],
  agentId: 'agent-1',
  messages: [],
  messagesOffset: 0,
  totalMessages: 0,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  store.dispatch(setAgents([]));
  store.dispatch(setCurrentAgentId('main'));
  store.dispatch(setCurrentSession(null));
  store.dispatch(clearActiveSkills());
  vi.unstubAllGlobals();
});

describe('coworkService.clearSession', () => {
  test('restores the current agent default skills for a new task', () => {
    store.dispatch(setAgents([{
      id: 'agent-1',
      name: 'Agent 1',
      description: '',
      icon: '',
      model: '',
      workingDirectory: '',
      enabled: true,
      pinned: false,
      pinOrder: null,
      isDefault: false,
      source: 'custom',
      skillIds: ['docx', 'web-search'],
      subagentAllowAgentIds: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-1'));
    store.dispatch(setCurrentSession(makeSession()));

    coworkService.clearSession({ restoreAgentSkills: true });

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().skill.activeSkillIds).toEqual(['docx', 'web-search']);
  });

  test('does not change active skills for generic session clearing', () => {
    store.dispatch(setActiveSkillIds(['xlsx']));
    store.dispatch(setCurrentSession(makeSession()));

    coworkService.clearSession();

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().skill.activeSkillIds).toEqual(['xlsx']);
  });

  test('clears active skills when the current agent has no default skills', () => {
    store.dispatch(setAgents([{
      id: 'agent-1',
      name: 'Agent 1',
      description: '',
      icon: '',
      model: '',
      workingDirectory: '',
      enabled: true,
      pinned: false,
      pinOrder: null,
      isDefault: false,
      source: 'custom',
      skillIds: [],
      subagentAllowAgentIds: [],
    }]));
    store.dispatch(setCurrentAgentId('agent-1'));
    store.dispatch(setActiveSkillIds(['xlsx']));

    coworkService.clearSession({ restoreAgentSkills: true });

    expect(store.getState().skill.activeSkillIds).toEqual([]);
  });
});

describe('coworkService.reloadSessionsForIdentityChange', () => {
  test('clears the previous identity and loads the active identity session list', async () => {
    store.dispatch(setCurrentSession(makeSession()));
    store.dispatch(setSessions([makeSession()]));
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          listSessions: vi.fn(async () => ({
            success: true,
            sessions: [{
              id: 'session-2',
              title: 'Session 2',
              status: CoworkSessionStatusValue.Completed,
              pinned: false,
              pinOrder: null,
              agentId: 'main',
              parentSessionId: null,
              forkedAt: null,
              createdAt: 2,
              updatedAt: 2,
            }],
            hasMore: false,
          })),
        },
      },
    });

    await coworkService.reloadSessionsForIdentityChange('main');

    expect(store.getState().cowork.currentSession).toBeNull();
    expect(store.getState().cowork.sessions.map(session => session.id)).toEqual(['session-2']);
    expect(window.electron.cowork.listSessions).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      agentId: 'main',
    });
  });

  test('ignores a session detail response started before the identity changed', async () => {
    let resolveSession: ((value: { success: true; session: CoworkSession }) => void) | undefined;
    const staleSessionResult = new Promise<{ success: true; session: CoworkSession }>((resolve) => {
      resolveSession = resolve;
    });
    vi.stubGlobal('window', {
      electron: {
        cowork: {
          getSession: vi.fn(() => staleSessionResult),
          listSessions: vi.fn(async () => ({ success: true, sessions: [], hasMore: false })),
        },
        log: { fromRenderer: vi.fn() },
      },
    });

    const staleLoad = coworkService.loadSession('session-1');
    await coworkService.reloadSessionsForIdentityChange('main');
    resolveSession?.({ success: true, session: makeSession() });
    await staleLoad;

    expect(store.getState().cowork.currentSession).toBeNull();
  });
});
