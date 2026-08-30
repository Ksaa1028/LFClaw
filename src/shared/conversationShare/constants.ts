export const ConversationShareIpc = {
  Preview: 'conversationShare:preview', Recipients: 'conversationShare:recipients',
  Create: 'conversationShare:create',
  Inbox: 'conversationShare:inbox', Read: 'conversationShare:read', Delete: 'conversationShare:delete', Import: 'conversationShare:import',
  PendingLink: 'conversationShare:pendingLink', LinkAvailable: 'conversationShare:linkAvailable',
} as const;
export const ConversationShareEvent = {
  Compose: 'conversationShare:compose',
  Inbox: 'conversationShare:open-inbox',
  UnreadChanged: 'conversationShare:unread-changed',
} as const;
export const ConversationShareMode = { Link: 'link', Direct: 'direct' } as const;
export type ConversationShareMode = typeof ConversationShareMode[keyof typeof ConversationShareMode];
export const ConversationShareRole = { User: 'user', Assistant: 'assistant' } as const;
export const SHARED_CONTEXT_KIND = 'shared-conversation-context';
export const SHARE_REQUEST_TIMEOUT_MS = 30_000;
export const SHARE_INBOX_POLL_INTERVAL_MS = 5_000;
export const SHARE_MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const SHARE_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export interface ShareMessage { id: string; role: 'user' | 'assistant'; content: string; timestamp: number }
export interface ShareAttachment { id: string; name: string; size: number; sha256: string; base64: string }
export interface ShareRecipient { id: string; name: string; department?: string }
export interface ShareSummary {
  id: string; title: string; sender: ShareRecipient; createdAt: number;
  mode: ConversationShareMode; recipientIds: string[]; messageCount: number;
}
export interface ShareInbox { items: ShareSummary[]; scope: string }
export interface ConversationSnapshot extends ShareSummary { schemaVersion: 1; messages: ShareMessage[]; attachments: ShareAttachment[] }
export interface SharePreviewAttachment { id: string; name: string; size: number }
export interface SharePreview { title: string; senderName: string; messages: ShareMessage[]; attachments: SharePreviewAttachment[] }
export interface ShareCreateInput {
  sessionId: string; mode: ConversationShareMode; recipientIds: string[]; requestId: string;
}
export type ShareResult<T> = { success: true; data: T } | { success: false; error: string };
export interface ConversationShareApi {
  pendingLink: () => Promise<string | null>;
  onLink: (callback: () => void) => () => void;
  preview: (sessionId: string) => Promise<ShareResult<SharePreview>>;
  recipients: () => Promise<ShareResult<ShareRecipient[]>>;
  create: (input: ShareCreateInput) => Promise<ShareResult<{ id: string; url: string }>>;
  inbox: () => Promise<ShareResult<ShareInbox>>;
  read: (idOrUrl: string) => Promise<ShareResult<ConversationSnapshot>>;
  delete: (idOrUrl: string) => Promise<ShareResult<{ deleted: true }>>;
  import: (idOrUrl: string) => Promise<ShareResult<{ sessionId: string }>>;
}
