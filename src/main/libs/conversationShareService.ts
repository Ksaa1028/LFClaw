import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { app, ipcMain, net } from 'electron';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import {
  ConversationShareIpc, ConversationShareMode, ConversationShareRole, type ConversationSnapshot,
SHARE_MAX_ATTACHMENT_BYTES, SHARE_MAX_TEXT_BYTES, SHARE_REQUEST_TIMEOUT_MS,
  type ShareCreateInput, SHARED_CONTEXT_KIND, type ShareInbox, type ShareMessage, type ShareRecipient, type ShareSummary,
} from '../../shared/conversationShare/constants';
import type { CoworkStore } from '../coworkStore';
import { t } from '../i18n';
import {
  collectConversationShareAttachments,
  prepareConversationContentForShare,
  restoreConversationContentAttachmentLinks,
} from './conversationShareAttachments';
import { buildSharedConversationContext, shareTranscript } from './conversationShareContext';
import type { LFClawEnterpriseAccess } from './lfclawEnterpriseAccess';

const API = '/api/enterprise/conversation-shares';
const MAX_BODY = 18 * 1024 * 1024;
const SHARE_REQUEST_RETRY_DELAYS_MS = [0, 350, 1_200] as const;
const SHARE_RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);
const SHARE_RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
]);
const LOCAL_DISMISSAL_KEY_PREFIX = 'conversationShare.dismissed.v1';
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().max(200),
  sender: z.object({ id: z.string(), name: z.string().max(200) }), createdAt: z.number().finite(),
  mode: z.enum(['link', 'direct']), recipientIds: z.array(z.string()).max(100), messageCount: z.number().int(),
  messages: z.array(z.object({ id: z.string().max(100), role: z.enum(['user', 'assistant']), content: z.string().max(SHARE_MAX_TEXT_BYTES), timestamp: z.number().finite() })).min(1).max(2000),
  attachments: z.array(z.object({ id: z.string(), name: z.string().max(200), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string() })).max(10),
});

export function parseShareId(value: string, server: string): string {
  if (/^[a-f0-9]{64}$/.test(value)) return value;
  const url = new URL(value);
  const configured = new URL(server);
  if (url.origin !== configured.origin || url.username || url.password) throw new Error(t('shareWrongServer'));
  const match = url.pathname.match(/^\/share\/([a-f0-9]{64})$/);
  if (!match) throw new Error(t('shareInvalidLink'));
  return match[1];
}

export class ConversationShareService {
  constructor(private readonly deps: { access: () => LFClawEnterpriseAccess; store: () => CoworkStore; db: () => Database.Database; cwd: () => string }) {}

  private identity() {
    const access = this.deps.access().getCurrentAccess();
    if (!access) throw new Error(t('shareSignIn'));
    return access;
  }

  private identityScope(access: ReturnType<ConversationShareService['identity']>): string {
    return crypto.createHash('sha256')
      .update(`${access.serverUrl}\0${access.user.userId}`)
      .digest('hex')
      .slice(0, 16);
  }

  private localDismissalKey(access: ReturnType<ConversationShareService['identity']>, id: string): string {
    return `${LOCAL_DISMISSAL_KEY_PREFIX}.${this.identityScope(access)}.${id}`;
  }

  private locallyDismissed(access: ReturnType<ConversationShareService['identity']>, id: string): boolean {
    return Boolean(this.deps.db().prepare('SELECT 1 FROM kv WHERE key = ?').get(this.localDismissalKey(access, id)));
  }

  private rememberLocalDismissal(access: ReturnType<ConversationShareService['identity']>, id: string): void {
    this.deps.db().prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      this.localDismissalKey(access, id),
      JSON.stringify({ id }),
      Date.now(),
    );
  }

  private async request<T>(
    suffix: string,
    body?: unknown,
    method: 'GET' | 'POST' | 'DELETE' = body === undefined ? 'GET' : 'POST',
  ): Promise<T> {
    const access = this.identity();
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    for (const [attempt, delayMs] of SHARE_REQUEST_RETRY_DELAYS_MS.entries()) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        const response = await net.fetch(`${access.serverUrl.replace(/\/+$/, '')}${API}${suffix}`, {
          method, redirect: 'error',
          headers: { Authorization: `Bearer ${access.accessToken}`, 'Content-Type': 'application/json' },
          body: requestBody, signal: AbortSignal.timeout(SHARE_REQUEST_TIMEOUT_MS),
        });
        if (SHARE_RETRYABLE_HTTP_STATUSES.has(response.status) && attempt < SHARE_REQUEST_RETRY_DELAYS_MS.length - 1) {
          console.warn(`[ConversationShare] Retrying transient HTTP ${response.status} path=${suffix || '/'} attempt=${attempt + 1}`);
          await response.body?.cancel().catch(() => {});
          continue;
        }
        if (response.status === 404) throw new Error(t('shareServerUnavailable'));
        if (!response.ok) {
          console.warn(`[ConversationShare] Request rejected with HTTP ${response.status} path=${suffix || '/'}`);
          throw new Error(response.status === 401 || response.status === 403 ? t('sharePermissionDenied') : t('shareRequestFailed'));
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error(t('shareRequestFailed'));
        const chunks: Buffer[] = []; let length = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > MAX_BODY) { await reader.cancel(); throw new Error(t('shareTooLarge')); }
            chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { code: number; data: T };
        if (payload.code !== 0) throw new Error(t('shareRequestFailed'));
        // Account switching during a request must not import another user's data.
        const current = this.identity();
        if (current.user.userId !== access.user.userId || current.serverUrl !== access.serverUrl) throw new Error(t('shareSignIn'));
        return payload.data;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const retryable = error instanceof TypeError || SHARE_RETRYABLE_NETWORK_CODES.has(code);
        if (retryable && attempt < SHARE_REQUEST_RETRY_DELAYS_MS.length - 1) {
          console.warn(`[ConversationShare] Retrying transient network failure path=${suffix || '/'} attempt=${attempt + 1}`);
          continue;
        }
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || retryable)) {
          throw new Error(t('shareRequestFailed'));
        }
        throw error;
      }
    }
    throw new Error(t('shareRequestFailed'));
  }

  private async source(sessionId: string) {
    const access = this.identity();
    const session = this.deps.store().getSession(sessionId, Number.MAX_SAFE_INTEGER);
    if (!session) throw new Error(t('shareSessionMissing'));
    const shareableMessages = session.messages.filter(message => {
      const hasAttachments = (Array.isArray(message.metadata?.imageAttachments) && message.metadata.imageAttachments.length > 0)
        || (Array.isArray(message.metadata?.imageAttachmentPreviews) && message.metadata.imageAttachmentPreviews.length > 0)
        || (Array.isArray(message.metadata?.localMediaAttachments) && message.metadata.localMediaAttachments.length > 0);
      return (message.type === ConversationShareRole.User || message.type === ConversationShareRole.Assistant)
        && (Boolean(message.content.trim()) || hasAttachments)
        && !message.metadata?.hidden
        && !message.metadata?.isThinking;
    });
    const messages: ShareMessage[] = shareableMessages.map(message => ({
      id: message.id,
      role: message.type as ShareMessage['role'],
      content: message.content,
      timestamp: message.timestamp,
    }));
    if (!messages.length || messages.length > 2000
      || messages.reduce((sum, message) => sum + Buffer.byteLength(message.content), 0) > SHARE_MAX_TEXT_BYTES) {
      throw new Error(t('shareTooLarge'));
    }
    return {
      title: session.title,
      senderName: access.user.nickname.trim() || access.user.userId,
      messages,
      attachments: await collectConversationShareAttachments(shareableMessages),
    };
  }

  async preview(sessionId: string) {
    const source = await this.source(sessionId);
    return {
      title: source.title,
      senderName: source.senderName,
      messages: source.messages,
      attachments: source.attachments.map(({ id, name, size }) => ({ id, name, size })),
    };
  }

  recipients() { return this.request<ShareRecipient[]>('/recipients'); }
  async inbox(): Promise<ShareInbox> {
    const access = this.identity();
    const items = await this.request<ShareSummary[]>('');
    const scope = this.identityScope(access);
    return { items: items.filter(item => !this.locallyDismissed(access, item.id)), scope };
  }

  async create(input: ShareCreateInput) {
    const access = this.identity();
    if (!input || !Object.values(ConversationShareMode).includes(input.mode)
      || !Array.isArray(input.recipientIds) || input.recipientIds.length > 100) {
      throw new Error(t('shareRequestFailed'));
    }
    if (input.mode === ConversationShareMode.Direct && !input.recipientIds.length) {
      throw new Error(t('shareSelectRecipient'));
    }
    const source = await this.source(input.sessionId);
    const result = await this.request<ShareSummary>('', {
      title: source.title.slice(0, 200),
      messages: source.messages.map(message => ({
        ...message,
        content: prepareConversationContentForShare(message.content, source.attachments),
      })),
      attachments: source.attachments.map(({ name, base64 }) => ({ name, base64 })),
      mode: input.mode,
      recipientIds: input.mode === ConversationShareMode.Direct ? [...new Set(input.recipientIds)] : [],
      requestId: input.requestId,
    });
    if (!/^[a-f0-9]{64}$/.test(result.id)) throw new Error(t('shareRequestFailed'));
    return { id: result.id, url: `${access.serverUrl.replace(/\/+$/, '')}/share/${result.id}` };
  }

  async read(idOrUrl: string): Promise<ConversationSnapshot> {
    const id = parseShareId(idOrUrl.trim(), this.identity().serverUrl);
    const snapshot = snapshotSchema.parse(await this.request<unknown>(`/${id}`));
    if (snapshot.id !== id || snapshot.messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0) > SHARE_MAX_TEXT_BYTES) throw new Error(t('shareTooLarge'));
    let bytes = 0;
    for (const attachment of snapshot.attachments) {
      const content = Buffer.from(attachment.base64, 'base64');
      bytes += content.length;
      if (bytes > SHARE_MAX_ATTACHMENT_BYTES || content.length !== attachment.size || crypto.createHash('sha256').update(content).digest('hex') !== attachment.sha256) throw new Error(t('shareRequestFailed'));
    }
    return snapshot;
  }

  async delete(idOrUrl: string): Promise<{ deleted: true }> {
    const access = this.identity();
    const id = parseShareId(idOrUrl, access.serverUrl);
    try {
      await this.request<{ deleted: true }>(`/${id}`, undefined, 'DELETE');
    } catch (error) {
      // Older enterprise servers do not expose DELETE yet. Preserve the user's
      // explicit inbox deletion locally so the item does not reappear while the
      // server is being upgraded.
      console.warn('[ConversationShare] Server-side inbox deletion unavailable; keeping a local dismissal.', error);
    }
    this.rememberLocalDismissal(access, id);
    return { deleted: true };
  }

  async import(idOrUrl: string): Promise<{ sessionId: string }> {
    const access = this.identity();
    const snapshot = await this.read(idOrUrl);
    const db = this.deps.db();
    const owner = crypto.createHash('sha256').update(access.user.userId).digest('hex').slice(0, 16);
    const server = access.serverUrl;
    db.exec('CREATE TABLE IF NOT EXISTS conversation_share_imports (owner TEXT NOT NULL, server TEXT NOT NULL, share_id TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (owner, server, share_id))');
    const existing = db.prepare('SELECT session_id FROM conversation_share_imports WHERE owner = ? AND server = ? AND share_id = ?').get(owner, server, snapshot.id) as { session_id: string } | undefined;
    if (existing && this.deps.store().getSession(existing.session_id, 0)) return { sessionId: existing.session_id };
    const base = path.join(app.getPath('userData'), 'conversation-shares', owner);
    await fs.promises.mkdir(base, { recursive: true });
    const directory = await fs.promises.mkdtemp(path.join(base, `${snapshot.id}-`));
    const transcriptPath = path.join(directory, 'transcript.txt');
    await fs.promises.writeFile(transcriptPath, shareTranscript(snapshot), { flag: 'wx' });
    const files: string[] = [];
    for (const [i, attachment] of snapshot.attachments.entries()) {
      const extension = path.extname(attachment.name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
      const file = path.join(directory, `attachment-${i}${extension}`);
      await fs.promises.writeFile(file, Buffer.from(attachment.base64, 'base64'), { flag: 'wx' });
      files.push(file);
    }
    if (this.identity().user.userId !== access.user.userId || this.identity().serverUrl !== server) throw new Error(t('shareSignIn'));
    return db.transaction(() => {
      // Recheck inside the transaction to make concurrent receive clicks idempotent.
      const row = db.prepare('SELECT session_id FROM conversation_share_imports WHERE owner = ? AND server = ? AND share_id = ?').get(owner, server, snapshot.id) as { session_id: string } | undefined;
      if (row && this.deps.store().getSession(row.session_id, 0)) return { sessionId: row.session_id };
      const store = this.deps.store();
      const session = store.createSession(`${t('shareReceivedPrefix')}${snapshot.title}`, this.deps.cwd());
      for (const message of snapshot.messages) store.addMessage(session.id, {
        type: message.role,
        content: restoreConversationContentAttachmentLinks(message.content, snapshot.attachments, files),
        metadata: { sharedSnapshotId: snapshot.id, sharedAuthor: snapshot.sender.name },
      }, message.timestamp);
      store.addMessage(session.id, { type: 'system', content: buildSharedConversationContext(snapshot, transcriptPath, files), metadata: { hidden: true, kind: SHARED_CONTEXT_KIND } });
      db.prepare('INSERT OR REPLACE INTO conversation_share_imports (owner, server, share_id, session_id) VALUES (?, ?, ?, ?)').run(owner, server, snapshot.id, session.id);
      return { sessionId: session.id };
    })();
  }
}

export function registerConversationShareHandlers(service: ConversationShareService): void {
  const handle = <T>(channel: string, fn: (input: T) => unknown, logFailure = true) => ipcMain.handle(channel, async (_event, input: T) => {
    try { return { success: true, data: await fn(input) }; }
    catch (error) {
      if (logFailure) console.error('[ConversationShare] Operation failed:', error);
      return { success: false, error: error instanceof Error ? error.message : t('shareRequestFailed') };
    }
  });
  handle(ConversationShareIpc.Preview, (id: string) => service.preview(id));
  handle(ConversationShareIpc.Recipients, () => service.recipients());
  handle(ConversationShareIpc.Create, (input: ShareCreateInput) => service.create(input));
  handle(ConversationShareIpc.Inbox, () => service.inbox(), false);
  handle(ConversationShareIpc.Read, (id: string) => service.read(id));
  handle(ConversationShareIpc.Delete, (id: string) => service.delete(id));
  handle(ConversationShareIpc.Import, (id: string) => service.import(id));
}
