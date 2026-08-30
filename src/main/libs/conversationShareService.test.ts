import Sqlite from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { ConversationShareMode, ConversationShareRole, type ConversationSnapshot } from '../../shared/conversationShare/constants';

const electronMocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  userData: '',
}));

vi.mock('electron', () => ({
  app: { getPath: () => electronMocks.userData },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  net: { fetch: electronMocks.fetch },
}));

import { ConversationShareService, parseShareId } from './conversationShareService';

const shareId = 'a'.repeat(64);
const attachmentBytes = Buffer.from([0, 1, 2, 250, 255]);
const snapshot: ConversationSnapshot = {
  schemaVersion: 1,
  id: shareId,
  title: '已分享的项目讨论',
  sender: { id: 'sender-1', name: '发送人' },
  createdAt: 1_780_000_000_000,
  mode: ConversationShareMode.Direct,
  recipientIds: ['owner-1'],
  messageCount: 2,
  messages: [
    { id: 'message-1', role: ConversationShareRole.User, content: '请继续分析这个项目。', timestamp: 1_780_000_000_001 },
    { id: 'message-2', role: ConversationShareRole.Assistant, content: '已整理好背景。', timestamp: 1_780_000_000_002 },
  ],
  attachments: [{
    id: '0', name: 'evidence.bin', size: attachmentBytes.length,
    sha256: crypto.createHash('sha256').update(attachmentBytes).digest('hex'),
    base64: attachmentBytes.toString('base64'),
  }],
};

const createTestDatabase = (): Sqlite.Database => {
  const db = new Sqlite(':memory:');
  db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  return db;
};

describe('conversation share client service', () => {
  const temporaryDirectories: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    electronMocks.userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-import-'));
    temporaryDirectories.push(electronMocks.userData);
    electronMocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: snapshot }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  });

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => (
      fs.promises.rm(directory, { recursive: true, force: true })
    )));
  });

  test('accepts only links belonging to the configured enterprise server', () => {
    expect(parseShareId(shareId, 'https://enterprise.example.com')).toBe(shareId);
    expect(parseShareId(`https://enterprise.example.com/share/${shareId}`, 'https://enterprise.example.com')).toBe(shareId);
    expect(() => parseShareId(`https://other.example.com/share/${shareId}`, 'https://enterprise.example.com')).toThrow();
  });

  test('previews and publishes the entire visible conversation with its existing attachments', async () => {
    const db = createTestDatabase();
    const imageBytes = Buffer.from('conversation-image');
    let requestedMessageLimit = 0;
    const store = {
      getSession: (_id: string, messageLimit: number) => {
        requestedMessageLimit = messageLimit;
        return {
          id: 'source-session',
          title: '完整项目讨论',
          messages: [
            { id: 'hidden', type: 'system', content: 'secret system prompt', timestamp: 1, metadata: {} },
            {
              id: 'user-1', type: 'user', content: '请分析附件。', timestamp: 2,
              metadata: {
                imageAttachmentPreviews: [{
                  name: 'chart.png', mimeType: 'image/png', originalMimeType: 'image/png',
                  originalSizeBytes: imageBytes.length, base64Data: imageBytes.toString('base64'), isPreview: true,
                }],
              },
            },
            { id: 'tool-1', type: 'tool_result', content: 'private tool output', timestamp: 3, metadata: {} },
            { id: 'assistant-1', type: 'assistant', content: '分析完成。', timestamp: 4, metadata: {} },
          ],
        };
      },
    };
    const access = {
      serverUrl: 'https://enterprise.example.com', accessToken: 'test-token',
      user: { userId: 'owner-1', nickname: '李祺' },
    };
    const service = new ConversationShareService({
      access: () => ({ getCurrentAccess: () => access }) as never,
      store: () => store as never,
      db: () => db,
      cwd: () => electronMocks.userData,
    });
    try {
      const preview = await service.preview('source-session');
      expect(requestedMessageLimit).toBe(Number.MAX_SAFE_INTEGER);
      expect(preview.senderName).toBe('李祺');
      expect(preview.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);
      expect(preview.attachments).toEqual([{ id: expect.stringMatching(/^[a-f0-9]{64}$/), name: 'chart.png', size: imageBytes.length }]);

      await service.create({
        sessionId: 'source-session',
        mode: ConversationShareMode.Direct,
        recipientIds: ['recipient-1'],
        requestId: 'request-1',
      });
      const request = electronMocks.fetch.mock.calls.at(-1)?.[1] as RequestInit;
      const body = JSON.parse(String(request.body)) as {
        messages: Array<{ id: string }>;
        attachments: Array<{ name: string; base64: string }>;
        recipientIds: string[];
      };
      expect(body.messages.map(message => message.id)).toEqual(['user-1', 'assistant-1']);
      expect(body.attachments).toEqual([{ name: 'chart.png', base64: imageBytes.toString('base64') }]);
      expect(body.recipientIds).toEqual(['recipient-1']);
    } finally {
      db.close();
    }
  });

  test('scopes inbox read state to the enterprise server and employee', async () => {
    const db = createTestDatabase();
    const access = {
      serverUrl: 'https://enterprise.example.com', accessToken: 'test-token',
      user: { userId: 'owner-1', nickname: '李祺' },
    };
    electronMocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      data: [{
        id: shareId,
        title: snapshot.title,
        sender: snapshot.sender,
        createdAt: snapshot.createdAt,
        mode: snapshot.mode,
        recipientIds: snapshot.recipientIds,
        messageCount: snapshot.messageCount,
      }],
    }), { status: 200 }));
    const service = new ConversationShareService({
      access: () => ({ getCurrentAccess: () => access }) as never,
      store: () => ({}) as never,
      db: () => db,
      cwd: () => electronMocks.userData,
    });
    try {
      const inbox = await service.inbox();
      expect(inbox.items).toHaveLength(1);
      expect(inbox.scope).toMatch(/^[a-f0-9]{16}$/);
    } finally {
      db.close();
    }
  });

  test('deletes one received share through the recipient-scoped endpoint', async () => {
    const db = createTestDatabase();
    const access = {
      serverUrl: 'https://enterprise.example.com', accessToken: 'test-token',
      user: { userId: 'owner-1', nickname: '李祺' },
    };
    electronMocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      code: 0,
      data: { deleted: true },
    }), { status: 200 }));
    const service = new ConversationShareService({
      access: () => ({ getCurrentAccess: () => access }) as never,
      store: () => ({}) as never,
      db: () => db,
      cwd: () => electronMocks.userData,
    });
    try {
      await expect(service.delete(shareId)).resolves.toEqual({ deleted: true });
      expect(electronMocks.fetch).toHaveBeenCalledWith(
        `https://enterprise.example.com/api/enterprise/conversation-shares/${shareId}`,
        expect.objectContaining({ method: 'DELETE' }),
      );
    } finally {
      db.close();
    }
  });

  test('keeps an inbox deletion locally while an older server lacks DELETE support', async () => {
    const db = createTestDatabase();
    const access = {
      serverUrl: 'https://enterprise.example.com', accessToken: 'test-token',
      user: { userId: 'owner-1', nickname: '李祺' },
    };
    const summary = {
      id: shareId,
      title: snapshot.title,
      sender: snapshot.sender,
      createdAt: snapshot.createdAt,
      mode: snapshot.mode,
      recipientIds: snapshot.recipientIds,
      messageCount: snapshot.messageCount,
    };
    electronMocks.fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: [summary] }), { status: 200 }));
    const service = new ConversationShareService({
      access: () => ({ getCurrentAccess: () => access }) as never,
      store: () => ({}) as never,
      db: () => db,
      cwd: () => electronMocks.userData,
    });
    try {
      await expect(service.delete(shareId)).resolves.toEqual({ deleted: true });
      await expect(service.inbox()).resolves.toMatchObject({ items: [] });
    } finally {
      db.close();
    }
  });

  test('retries transient gateway failures before reporting the share unavailable', async () => {
    const db = createTestDatabase();
    const access = {
      serverUrl: 'https://enterprise.example.com', accessToken: 'test-token',
      user: { userId: 'owner-1', nickname: '李祺' },
    };
    electronMocks.fetch
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 }));
    const service = new ConversationShareService({
      access: () => ({ getCurrentAccess: () => access }) as never,
      store: () => ({}) as never,
      db: () => db,
      cwd: () => electronMocks.userData,
    });
    try {
      await expect(service.recipients()).resolves.toEqual([]);
      expect(electronMocks.fetch).toHaveBeenCalledTimes(3);
    } finally {
      db.close();
    }
  });

  test('imports an immutable snapshot once and restores attachment bytes', async () => {
    const db = createTestDatabase();
    const sessions = new Map<string, { id: string; title: string; messages: Array<Record<string, unknown>> }>();
    let created = 0;
    const store = {
      getSession: (id: string) => sessions.get(id) ?? null,
      createSession: (title: string) => {
        created++;
        const session = { id: `received-${created}`, title, messages: [] as Array<Record<string, unknown>> };
        sessions.set(session.id, session);
        return session;
      },
      addMessage: (id: string, message: Record<string, unknown>, timestamp?: number) => {
        sessions.get(id)?.messages.push({ ...message, timestamp });
      },
    };
    const access = {
      serverUrl: 'https://enterprise.example.com', accessToken: 'test-token',
      user: { userId: 'owner-1' },
    };
    const service = new ConversationShareService({
      access: () => ({ getCurrentAccess: () => access }) as never,
      store: () => store as never,
      db: () => db,
      cwd: () => electronMocks.userData,
    });
    try {
      const first = await service.import(shareId);
      const second = await service.import(shareId);

      expect(second).toEqual(first);
      expect(created).toBe(1);
      const received = sessions.get(first.sessionId)!;
      expect(received.messages.filter(message => message.type === 'user' || message.type === 'assistant')).toHaveLength(2);
      expect(received.messages.at(-1)?.metadata).toMatchObject({ hidden: true, kind: 'shared-conversation-context' });

      const importedFiles = await fs.promises.readdir(path.join(
        electronMocks.userData,
        'conversation-shares',
        crypto.createHash('sha256').update('owner-1').digest('hex').slice(0, 16),
        (await fs.promises.readdir(path.join(
          electronMocks.userData,
          'conversation-shares',
          crypto.createHash('sha256').update('owner-1').digest('hex').slice(0, 16),
        )))[0],
      ));
      const attachmentName = importedFiles.find(name => name.startsWith('attachment-'))!;
      const ownerDirectory = path.join(
        electronMocks.userData,
        'conversation-shares',
        crypto.createHash('sha256').update('owner-1').digest('hex').slice(0, 16),
      );
      const shareDirectory = path.join(ownerDirectory, (await fs.promises.readdir(ownerDirectory))[0]);
      expect(await fs.promises.readFile(path.join(shareDirectory, attachmentName))).toEqual(attachmentBytes);
      expect(snapshot.messages).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
