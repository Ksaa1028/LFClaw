import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ConversationShareEvent,
  ConversationShareRole,
  type ConversationSnapshot,
  SHARE_INBOX_POLL_INTERVAL_MS,
  type ShareSummary,
} from '../../../shared/conversationShare/constants';
import { i18nService } from '../../services/i18n';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import {
  CONVERSATION_SHARE_PAGE_SIZE,
  paginateConversationShares,
} from './conversationSharePagination';

const SHARE_SEEN_STORAGE_PREFIX = 'lfclaw.conversationShare.seen.';
const buttonClass = 'rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface disabled:opacity-50';
const t = (key: string) => i18nService.t(key);

function markSharesSeen(scope: string, items: ShareSummary[]): void {
  try {
    const stored = JSON.parse(window.localStorage.getItem(`${SHARE_SEEN_STORAGE_PREFIX}${scope}`) || '[]');
    const seen = new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
    items.forEach(item => seen.add(item.id));
    window.localStorage.setItem(`${SHARE_SEEN_STORAGE_PREFIX}${scope}`, JSON.stringify([...seen].slice(-500)));
  } catch {
    // The page is still considered read for this running client.
  }
  window.dispatchEvent(new CustomEvent(ConversationShareEvent.UnreadChanged, { detail: 0 }));
}

interface ConversationShareInboxViewProps {
  initialShare?: string | null;
  onInitialShareConsumed?: () => void;
  onContinue: (sessionId: string) => Promise<void>;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

const ConversationShareInboxView: React.FC<ConversationShareInboxViewProps> = ({
  initialShare,
  onInitialShareConsumed,
  onContinue,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const [inbox, setInbox] = useState<ShareSummary[]>([]);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState('');
  const [page, setPage] = useState(1);
  const requestSequence = useRef(0);
  const inboxInFlight = useRef(false);
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const paginated = useMemo(() => paginateConversationShares(inbox, page), [inbox, page]);

  useEffect(() => {
    if (page !== paginated.page) setPage(paginated.page);
  }, [page, paginated.page]);

  const refreshInbox = useCallback(async (showErrors = false) => {
    if (inboxInFlight.current) return;
    inboxInFlight.current = true;
    try {
      const result = await window.electron.conversationShare.inbox();
      if (result.success) {
        setInbox(result.data.items);
        markSharesSeen(result.data.scope, result.data.items);
        if (showErrors) setError('');
      } else if (showErrors) {
        setError(result.error);
      }
    } catch {
      if (showErrors) setError(t('shareRequestFailed'));
    } finally {
      inboxInFlight.current = false;
    }
  }, []);

  const readShare = useCallback(async (value: string) => {
    const version = ++requestSequence.current;
    setBusy(true);
    setError('');
    setSnapshot(null);
    try {
      const result = await window.electron.conversationShare.read(value);
      if (version !== requestSequence.current) return;
      if (result.success) setSnapshot(result.data);
      else setError(result.error);
    } catch {
      if (version === requestSequence.current) setError(t('shareRequestFailed'));
    } finally {
      if (version === requestSequence.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshInbox(true);
    const timer = window.setInterval(() => { void refreshInbox(); }, SHARE_INBOX_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshInbox]);

  useEffect(() => {
    const value = initialShare?.trim();
    if (!value) return;
    setLink(value);
    void readShare(value);
    onInitialShareConsumed?.();
  }, [initialShare, onInitialShareConsumed, readShare]);

  const receive = async () => {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.electron.conversationShare.import(snapshot.id);
      if (!result.success) {
        setError(result.error);
        return;
      }
      await onContinue(result.data.sessionId);
    } catch {
      setError(t('shareRequestFailed'));
    } finally {
      setBusy(false);
    }
  };

  const deleteInboxItem = async (item: ShareSummary) => {
    setBusy(true);
    setError('');
    try {
      const result = await window.electron.conversationShare.delete(item.id);
      if (!result.success) {
        setError(result.error);
        return;
      }
      setInbox(items => items.filter(candidate => candidate.id !== item.id));
      setDeleteConfirmId('');
    } catch {
      setError(t('shareRequestFailed'));
    } finally {
      setBusy(false);
    }
  };

  return <div className="flex h-full flex-1 flex-col bg-background">
    <div className="draggable flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex h-8 items-center space-x-3">
        {isSidebarCollapsed && !isWindows && <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
          <button type="button" onClick={onToggleSidebar} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised">
            <SidebarToggleIcon className="h-4 w-4" isCollapsed />
          </button>
          <button type="button" onClick={onNewChat} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised">
            <ComposeIcon className="h-4 w-4" />
          </button>
          {updateBadge}
        </div>}
        <h1 className="text-lg font-semibold text-foreground">{t('shareInbox')}</h1>
      </div>
    </div>

    <div className="min-h-0 flex-1 overflow-hidden">
      <div className="mx-auto flex h-full w-full max-w-[1120px] flex-col px-6 py-6">
        {error && <p className="mb-4 shrink-0 rounded-lg bg-red-50 p-3 text-sm text-red-500" role="alert">{error}</p>}
        {busy && <p className="mb-3 shrink-0 text-sm text-secondary">{t('loading')}</p>}

        {snapshot ? <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0"><button className={buttonClass} disabled={busy} onClick={() => { ++requestSequence.current; setSnapshot(null); setError(''); }}>{t('shareBackToInbox')}</button></div>
          <section className="mt-5 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-surface p-5 [scrollbar-gutter:stable]">
            <h2 className="text-xl font-semibold">{snapshot.title}</h2>
            <p className="mt-1 text-sm text-secondary">{snapshot.sender.name} · {new Date(snapshot.createdAt).toLocaleString()}</p>
            <p className="my-4 text-sm text-secondary">{t('shareContinueNotice')}</p>
            <button className="mb-4 rounded-lg bg-primary px-5 py-3 text-white disabled:opacity-50" disabled={busy} onClick={() => void receive()}>{t('shareReceiveContinue')}</button>
            {snapshot.attachments.length > 0 && <div className="mb-4 rounded-xl border border-border p-3">
              {snapshot.attachments.map(attachment => <p key={attachment.id} className="text-sm">{t('shareAttachment')} {attachment.name} ({Math.ceil(attachment.size / 1024)} KB)</p>)}
            </div>}
            {snapshot.messages.map(message => <article className="my-3 rounded-xl border border-border p-4" key={message.id}>
              <small className="text-secondary">{message.role === ConversationShareRole.User ? snapshot.sender.name : t('shareAssistant')}</small>
              <p className="whitespace-pre-wrap break-words">{message.content}</p>
            </article>)}
          </section>
        </div> : <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-4 flex shrink-0 gap-2 rounded-2xl border border-border bg-surface p-4">
            <input className="min-w-0 flex-1 rounded-lg border border-border bg-transparent p-2" placeholder={t('sharePasteLink')} value={link} onChange={event => setLink(event.target.value)} />
            <button className={buttonClass} disabled={busy || !link.trim()} onClick={() => void readShare(link)}>{t('shareView')}</button>
            <button className={buttonClass} disabled={busy} onClick={() => void refreshInbox(true)}>{t('shareRefresh')}</button>
          </div>

          <div className="mb-3 flex shrink-0 items-center justify-between px-1 text-sm text-secondary">
            <span>{t('shareInboxTotal')} {inbox.length} {t('shareInboxItems')}</span>
            <span>{t('shareInboxPerPage')} {CONVERSATION_SHARE_PAGE_SIZE} {t('shareInboxItems')}</span>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            {!inbox.length && !busy && <div className="rounded-2xl border border-dashed border-border py-16 text-center text-secondary">{t('shareInboxEmpty')}</div>}
            {paginated.items.map(item => <div key={item.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3">
              <button className="min-w-0 flex-1 rounded-xl p-3 text-left hover:bg-black/5" disabled={busy} onClick={() => void readShare(item.id)}>
                <span className="block truncate font-medium">{item.title}</span>
                <span className="mt-1 block text-sm text-secondary">{item.sender.name} · {new Date(item.createdAt).toLocaleString()} · {item.messageCount} {t('shareMessages')}</span>
              </button>
              {deleteConfirmId === item.id ? <div className="flex shrink-0 items-center gap-2">
                <button className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-600 hover:bg-red-100 disabled:opacity-50" disabled={busy} onClick={() => void deleteInboxItem(item)}>{t('confirmDelete')}</button>
                <button className={buttonClass} disabled={busy} onClick={() => setDeleteConfirmId('')}>{t('cancel')}</button>
              </div> : <button className="shrink-0 rounded-lg border border-red-300 px-3 py-2 text-sm text-red-500 hover:bg-red-50 disabled:opacity-50" disabled={busy} onClick={() => setDeleteConfirmId(item.id)}>{t('shareDelete')}</button>}
            </div>)}
          </div>

          {paginated.pageCount > 1 && <div className="mt-4 flex shrink-0 items-center justify-center gap-3">
            <button className={buttonClass} disabled={paginated.page <= 1} onClick={() => setPage(current => current - 1)}><ChevronLeftIcon className="mr-1 inline h-4 w-4" />{t('sharePreviousPage')}</button>
            <span className="text-sm text-secondary">{t('sharePage')} {paginated.page} / {paginated.pageCount}</span>
            <button className={buttonClass} disabled={paginated.page >= paginated.pageCount} onClick={() => setPage(current => current + 1)}>{t('shareNextPage')}<ChevronRightIcon className="ml-1 inline h-4 w-4" /></button>
          </div>}
        </div>}
      </div>
    </div>
  </div>;
};

export default ConversationShareInboxView;
