import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ConversationShareEvent,
  ConversationShareMode,
  ConversationShareRole,
  SHARE_INBOX_POLL_INTERVAL_MS,
  type SharePreview,
  type ShareRecipient,
} from '../../../shared/conversationShare/constants';
import { copyTextToClipboard } from '../../services/clipboard';
import { i18nService } from '../../services/i18n';
import { filterShareRecipients } from './recipientSearch';

const buttonClass = 'rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface disabled:opacity-50';
const SHARE_SEEN_STORAGE_PREFIX = 'lfclaw.conversationShare.seen.';
const t = (key: string) => i18nService.t(key);

function readSeenShareIds(scope: string): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${SHARE_SEEN_STORAGE_PREFIX}${scope}`) || '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function publishUnreadCount(count: number): void {
  window.dispatchEvent(new CustomEvent(ConversationShareEvent.UnreadChanged, { detail: count }));
}

interface ConversationSharingProps {
  inboxActive: boolean;
  onOpenInbox: (share?: string) => void;
}

export default function ConversationSharing({ inboxActive, onOpenInbox }: ConversationSharingProps) {
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [mode, setMode] = useState<ConversationShareMode>(ConversationShareMode.Link);
  const [recipients, setRecipients] = useState<ShareRecipient[]>([]);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [recipientError, setRecipientError] = useState('');
  const [createdUrl, setCreatedUrl] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const request = useRef({ fingerprint: '', id: '' });
  const inboxInFlight = useRef(false);
  const matchingRecipients = useMemo(
    () => filterShareRecipients(recipients, search),
    [recipients, search],
  );

  const refreshUnread = useCallback(async () => {
    if (inboxActive) {
      publishUnreadCount(0);
      return;
    }
    if (inboxInFlight.current) return;
    inboxInFlight.current = true;
    try {
      const result = await window.electron.conversationShare.inbox();
      if (result.success) {
        const seen = readSeenShareIds(result.data.scope);
        publishUnreadCount(result.data.items.filter(item => !seen.has(item.id)).length);
      }
    } catch {
      // Inbox polling is best effort and must not interrupt ordinary chat.
    } finally {
      inboxInFlight.current = false;
    }
  }, [inboxActive]);

  useEffect(() => {
    const activeSequence = sequence;
    const compose = async (event: Event) => {
      const id = (event as CustomEvent<{ sessionId: string }>).detail?.sessionId;
      if (!id) return;
      const version = ++sequence.current;
      request.current = { fingerprint: '', id: '' };
      setIsComposeOpen(true);
      setSessionId(id);
      setPreview(null);
      setCreatedUrl('');
      setLinkCopied(false);
      setRecipientIds([]);
      setSearch('');
      setRecipients([]);
      setRecipientError('');
      setError('');
      setBusy(true);
      try {
        const result = await window.electron.conversationShare.preview(id);
        if (version !== sequence.current) return;
        if (result.success) setPreview(result.data);
        else setError(result.error);
        const people = await window.electron.conversationShare.recipients();
        if (version !== sequence.current) return;
        if (people.success) setRecipients(people.data);
        else {
          setRecipients([]);
          setRecipientError(people.error);
        }
      } catch {
        setError(t('shareRequestFailed'));
      } finally {
        if (version === sequence.current) setBusy(false);
      }
    };
    const openInbox = () => onOpenInbox();
    const openPending = async () => {
      const value = await window.electron.conversationShare.pendingLink();
      if (value) onOpenInbox(value);
    };
    const listener = (event: Event) => { void compose(event); };
    window.addEventListener(ConversationShareEvent.Compose, listener);
    window.addEventListener(ConversationShareEvent.Inbox, openInbox);
    const unsubscribe = window.electron.conversationShare.onLink(() => { void openPending(); });
    void openPending();
    return () => {
      ++activeSequence.current;
      window.removeEventListener(ConversationShareEvent.Compose, listener);
      window.removeEventListener(ConversationShareEvent.Inbox, openInbox);
      unsubscribe();
    };
  }, [onOpenInbox]);

  useEffect(() => {
    void refreshUnread();
    const timer = window.setInterval(() => { void refreshUnread(); }, SHARE_INBOX_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      publishUnreadCount(0);
    };
  }, [refreshUnread]);

  const publish = async () => {
    setBusy(true);
    setError('');
    try {
      const input = { sessionId, mode, recipientIds };
      const fingerprint = JSON.stringify(input);
      if (request.current.fingerprint !== fingerprint) {
        request.current = { fingerprint, id: crypto.randomUUID() };
      }
      const result = await window.electron.conversationShare.create({ ...input, requestId: request.current.id });
      if (result.success && mode === ConversationShareMode.Direct) {
        ++sequence.current;
        setIsComposeOpen(false);
      } else if (result.success) {
        setCreatedUrl(result.data.url);
      } else {
        setError(result.error);
      }
    } catch {
      setError(t('shareRequestFailed'));
    } finally {
      setBusy(false);
    }
  };

  const copyShareLink = async () => {
    if (await copyTextToClipboard(createdUrl)) {
      setLinkCopied(true);
      setError('');
    } else {
      setError(t('shareCopyManually'));
    }
  };

  if (!isComposeOpen) return null;
  return <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/30 p-6" role="dialog" aria-modal="true" aria-label={t('shareConversation')}>
    <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-surface p-6 text-foreground shadow-xl">
      <header className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{t('shareConversation')}</h2>
        <button className={buttonClass} disabled={busy} onClick={() => { ++sequence.current; setIsComposeOpen(false); }}>{t('close')}</button>
      </header>
      {error && <p className="mb-3 text-sm text-red-500" role="alert">{error}</p>}
      {busy && <p className="mb-3 text-sm text-secondary">{t('loading')}</p>}
      <div className="min-h-0 overflow-y-auto">
        {preview && <>
          <h3 className="font-medium">{preview.title}</h3>
          <p className="my-3 text-sm text-secondary">{t('sharePrivacyNotice')}</p>
          {createdUrl ? <div className="space-y-3 rounded-xl border border-border p-4">
            <p>{t(mode === ConversationShareMode.Direct ? 'shareSent' : 'shareLinkCreated')}</p>
            <input className="w-full rounded border border-border bg-transparent p-2" readOnly value={createdUrl} aria-label={t('shareLink')} onFocus={event => event.target.select()} />
            <button className={buttonClass} onClick={() => void copyShareLink()}>{t(linkCopied ? 'shareCopied' : 'shareCopyLink')}</button>
          </div> : <fieldset disabled={busy} className="space-y-4">
            <div className="flex gap-5">
              <label><input type="radio" checked={mode === ConversationShareMode.Link} onChange={() => setMode(ConversationShareMode.Link)} /> {t('shareLinkMode')}</label>
              <label><input type="radio" checked={mode === ConversationShareMode.Direct} onChange={() => setMode(ConversationShareMode.Direct)} /> {t('shareDirectMode')}</label>
            </div>
            <p className="text-sm text-secondary">{t(mode === ConversationShareMode.Link ? 'shareLinkAccess' : 'shareDirectAccess')}</p>
            {mode === ConversationShareMode.Direct && <div className="rounded border border-border p-3">
              <p className="mb-2 text-sm font-medium">{t('shareChooseRecipient')}</p>
              {recipientError && <p className="mb-2 text-sm text-red-500" role="alert">{recipientError}</p>}
              <input className="mb-2 w-full rounded border border-border bg-transparent p-2" value={search} onChange={event => setSearch(event.target.value)} placeholder={t('shareSearchRecipient')} />
              <div className="max-h-40 overflow-y-auto">
                {!recipientError && recipients.length === 0 && <p className="py-2 text-sm text-secondary">{t('shareNoRecipients')}</p>}
                {recipients.length > 0 && !search.trim() && <p className="py-2 text-sm text-secondary">{t('shareSearchRecipientHint')}</p>}
                {recipients.length > 0 && Boolean(search.trim()) && matchingRecipients.length === 0 && <p className="py-2 text-sm text-secondary">{t('shareRecipientNoMatch')}</p>}
                {matchingRecipients.map(person => <label key={person.id} className="mb-1 flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 hover:bg-black/5">
                  <input type="checkbox" checked={recipientIds.includes(person.id)} onChange={event => setRecipientIds(ids => event.target.checked ? [...new Set([...ids, person.id])] : ids.filter(id => id !== person.id))} />
                  <span className="min-w-0"><span className="block font-medium">{person.name}</span>{person.department && <span className="block text-xs text-secondary">{person.department}</span>}</span>
                </label>)}
              </div>
              {recipientIds.length > 0 && <p className="mt-2 text-sm text-secondary">{t('shareRecipientsSelected')}：{recipients.filter(person => recipientIds.includes(person.id)).map(person => person.name).join('、')}</p>}
            </div>}
            <p className="text-sm font-medium">{t('shareEntireConversation')}：{preview.messages.length} {t('shareMessages')}</p>
            <div className="max-h-64 overflow-y-auto rounded border border-border p-3">
              {preview.messages.map(message => <article className="mb-3 last:mb-0" key={message.id}>
                <span className="text-xs text-secondary">{message.role === ConversationShareRole.User ? preview.senderName || t('shareUser') : t('shareAssistant')}</span>
                <span className="block whitespace-pre-wrap break-words text-sm">{message.content.slice(0, 600)}{message.content.length > 600 ? '…' : ''}</span>
              </article>)}
            </div>
            <div className="rounded border border-border p-3">
              <p className="text-sm font-medium">{t('shareConversationAttachments')}</p>
              {preview.attachments.length === 0
                ? <p className="mt-1 text-sm text-secondary">{t('shareNoConversationAttachments')}</p>
                : preview.attachments.map(attachment => <p key={attachment.id} className="mt-1 text-sm">{attachment.name} ({Math.ceil(attachment.size / 1024)} KB)</p>)}
            </div>
            <button className="w-full rounded-lg bg-primary p-3 text-white disabled:opacity-50" disabled={mode === ConversationShareMode.Direct && (!recipientIds.length || Boolean(recipientError))} onClick={() => void publish()}>{t(mode === ConversationShareMode.Link ? 'shareCreateLink' : 'shareSend')}</button>
          </fieldset>}
        </>}
      </div>
    </div>
  </div>;
}
