import { CoworkUiEvent } from '../components/cowork/constants';
import { store } from '../store';
import { type CoworkDraftState, restoreDraftState } from '../store/slices/coworkSlice';
import { i18nService } from './i18n';

const RECOVERY_PREFIX = 'lfclaw.updateWorkspace.v1.';
const DRAFT_FIELDS = ['draftPrompts', 'draftAttachments', 'draftSelectedTextSnippets', 'draftKitIds', 'draftSkillIds', 'draftCollaborationModes', 'steerDrafts'] as const;
interface WorkspaceRecovery { owner: string; sessionId: string | null; drafts: CoworkDraftState }

async function ownerId(): Promise<string> {
  const result = await window.electron.enterprise.getStatus();
  const owner = result.status?.access?.user.userId;
  if (!result.success || !owner) throw new Error(i18nService.t('updateWorkspaceSaveFailed'));
  return owner;
}

export async function installUpdateWithWorkspace() {
  let recoveryKey: string | undefined;
  try {
    const owner = await ownerId();
    window.dispatchEvent(new Event(CoworkUiEvent.PrepareUpdate));
    const state = store.getState().cowork;
    const drafts = Object.fromEntries(DRAFT_FIELDS.map(key => [key, state[key]])) as CoworkDraftState;
    recoveryKey = RECOVERY_PREFIX + owner;
    await window.electron.store.set(recoveryKey, { owner, sessionId: state.currentSessionId, drafts } satisfies WorkspaceRecovery);
    const result = await window.electron.appUpdate.installReady();
    if (!result.success) await window.electron.store.remove(recoveryKey);
    return result;
  } catch (error) {
    if (recoveryKey) await window.electron.store.remove(recoveryKey).catch(() => {});
    console.error('[AppUpdate] Failed to preserve workspace:', error);
    return { success: false, error: i18nService.t('updateWorkspaceSaveFailed') };
  }
}

export async function restoreUpdateWorkspace(loadSession: (id: string) => Promise<unknown>): Promise<void> {
  try {
    const owner = await ownerId();
    const key = RECOVERY_PREFIX + owner;
    const saved = await window.electron.store.get(key) as WorkspaceRecovery | undefined;
    if (!saved || saved.owner !== owner || !saved.drafts || !DRAFT_FIELDS.every(field => saved.drafts[field] && typeof saved.drafts[field] === 'object')) return;
    // Only draft fields, never stale messages, runtime state, permissions or queued actions.
    const drafts = Object.fromEntries(DRAFT_FIELDS.map(field => [field, saved.drafts[field]])) as CoworkDraftState;
    store.dispatch(restoreDraftState(drafts));
    if (typeof saved.sessionId === 'string') await loadSession(saved.sessionId);
    await window.electron.store.remove(key);
  } catch (error) {
    console.warn('[AppUpdate] Workspace recovery postponed:', error);
  }
}
