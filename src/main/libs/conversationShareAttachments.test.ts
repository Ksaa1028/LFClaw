import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, test } from 'vitest';

import type { CoworkMessage } from '../coworkStore';
import {
  collectConversationShareAttachments,
  prepareConversationContentForShare,
  restoreConversationContentAttachmentLinks,
} from './conversationShareAttachments';

describe('conversation share attachments', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => (
      fs.promises.rm(directory, { force: true, recursive: true })
    )));
  });

  test('uses only attachments already recorded on conversation messages', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-attachment-'));
    directories.push(directory);
    const filePath = path.join(directory, 'result.txt');
    await fs.promises.writeFile(filePath, 'saved conversation output');
    const messages: CoworkMessage[] = [{
      id: 'assistant-1',
      type: 'assistant',
      content: '已生成附件。',
      timestamp: 1,
      metadata: { localMediaAttachments: [{ localPath: filePath, name: 'result.txt' }] },
    }];

    const attachments = await collectConversationShareAttachments(messages);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: 'result.txt', size: 25 });
    expect(Buffer.from(attachments[0].base64, 'base64').toString()).toBe('saved conversation output');
  });

  test('fails instead of silently omitting a missing conversation attachment', async () => {
    const messages: CoworkMessage[] = [{
      id: 'assistant-1',
      type: 'assistant',
      content: '附件已生成。',
      timestamp: 1,
      metadata: { localMediaAttachments: [{ localPath: path.join(os.tmpdir(), 'missing-lfclaw-share-file.bin') }] },
    }];

    await expect(collectConversationShareAttachments(messages)).rejects.toThrow();
  });

  test('includes a local file linked from the visible conversation body', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-linked-attachment-'));
    directories.push(directory);
    const filePath = path.join(directory, 'explorer weekly report.md');
    await fs.promises.writeFile(filePath, '# Weekly report');
    const messages: CoworkMessage[] = [{
      id: 'assistant-1',
      type: 'assistant',
      content: `附件：[explorer-weekly-report.md](${pathToFileURL(filePath).href})`,
      timestamp: 1,
    }];

    const attachments = await collectConversationShareAttachments(messages);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ name: 'explorer weekly report.md', size: 15 });
    expect(Buffer.from(attachments[0].base64, 'base64').toString()).toBe('# Weekly report');
  });

  test('uploads a file referenced by an assistant MEDIA token and restores it on the recipient', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-media-token-'));
    directories.push(directory);
    const senderPath = path.join(directory, 'sender', '出师表.txt');
    const recipientPath = path.join(directory, 'recipient', 'attachment-0.txt');
    await fs.promises.mkdir(path.dirname(senderPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(recipientPath), { recursive: true });
    await fs.promises.writeFile(senderPath, '先帝创业未半');
    await fs.promises.writeFile(recipientPath, '先帝创业未半');
    const messages: CoworkMessage[] = [{
      id: 'assistant-media',
      type: 'assistant',
      content: `附件已生成：\n\nMEDIA:${senderPath}`,
      timestamp: 1,
    }];

    const attachments = await collectConversationShareAttachments(messages);

    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe('出师表.txt');
    const portable = prepareConversationContentForShare(messages[0].content, attachments);
    expect(portable).not.toContain(senderPath);
    expect(portable).toContain(`[出师表.txt](lfclaw-attachment://${attachments[0].id})`);

    const restored = restoreConversationContentAttachmentLinks(portable, [{
      name: attachments[0].name,
      sha256: attachments[0].id,
    }], [recipientPath]);
    expect(restored).toContain(`[出师表.txt](${pathToFileURL(recipientPath).href})`);
  });

  test('fails instead of silently omitting a missing MEDIA token file', async () => {
    const missingPath = path.join(os.tmpdir(), 'missing-lfclaw-media-token.txt');
    const messages: CoworkMessage[] = [{
      id: 'assistant-media', type: 'assistant', timestamp: 1, content: `MEDIA:${missingPath}`,
    }];

    await expect(collectConversationShareAttachments(messages)).rejects.toThrow();
  });

  test('deduplicates a file recorded in metadata and linked in the message body', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-linked-dedupe-'));
    directories.push(directory);
    const filePath = path.join(directory, 'result.txt');
    await fs.promises.writeFile(filePath, 'result');
    const messages: CoworkMessage[] = [{
      id: 'assistant-1',
      type: 'assistant',
      content: `[result.txt](${pathToFileURL(filePath).href})`,
      timestamp: 1,
      metadata: { localMediaAttachments: [{ localPath: filePath, name: 'result.txt' }] },
    }];

    await expect(collectConversationShareAttachments(messages)).resolves.toHaveLength(1);
  });

  test('never uploads private agent memory or bootstrap files referenced in visible text', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-private-memory-'));
    directories.push(directory);
    const workspace = path.join(directory, 'LFClaw', 'openclaw', 'state', 'workspace-main-enterprise-owner');
    const memoryPath = path.join(workspace, 'MEMORY.md');
    const reportPath = path.join(directory, 'explorer-weekly-report.md');
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.writeFile(memoryPath, 'private memory');
    await fs.promises.writeFile(reportPath, 'shareable report');
    const messages: CoworkMessage[] = [{
      id: 'assistant-1',
      type: 'assistant',
      content: [
        `[MEMORY.md](${pathToFileURL(memoryPath).href})`,
        `[explorer-weekly-report.md](${pathToFileURL(reportPath).href})`,
      ].join('\n'),
      timestamp: 1,
    }];

    const attachments = await collectConversationShareAttachments(messages);

    expect(attachments.map(attachment => attachment.name)).toEqual(['explorer-weekly-report.md']);
  });

  test('also excludes private memory files recorded in attachment metadata', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-private-metadata-'));
    directories.push(directory);
    const memoryPath = path.join(directory, 'MEMORY.md');
    await fs.promises.writeFile(memoryPath, 'private memory');
    const messages: CoworkMessage[] = [{
      id: 'assistant-1',
      type: 'assistant',
      content: 'memory citation',
      timestamp: 1,
      metadata: { localMediaAttachments: [{ localPath: memoryPath, name: 'MEMORY.md' }] },
    }];

    await expect(collectConversationShareAttachments(messages)).resolves.toEqual([]);
  });

  test('replaces sender paths with portable references and restores recipient-local links', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lfclaw-share-link-rewrite-'));
    directories.push(directory);
    const senderPath = path.join(directory, 'sender', 'explorer-weekly-report.md');
    const recipientPath = path.join(directory, 'recipient', 'attachment-0.md');
    await fs.promises.mkdir(path.dirname(senderPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(recipientPath), { recursive: true });
    await fs.promises.writeFile(senderPath, 'report');
    await fs.promises.writeFile(recipientPath, 'report');
    const messages: CoworkMessage[] = [{
      id: 'assistant-1', type: 'assistant', timestamp: 1,
      content: `[explorer-weekly-report.md](${pathToFileURL(senderPath).href})`,
    }];
    const attachments = await collectConversationShareAttachments(messages);
    expect(attachments[0].sourcePaths).toEqual([senderPath]);

    const portable = prepareConversationContentForShare(messages[0].content, attachments);
    expect(portable).not.toContain(senderPath.replace(/\\/g, '/'));
    expect(portable).toContain(`lfclaw-attachment://${attachments[0].id}`);

    const restored = restoreConversationContentAttachmentLinks(portable, [{
      name: attachments[0].name,
      sha256: attachments[0].id,
    }], [recipientPath]);
    expect(restored).toContain(pathToFileURL(recipientPath).href);
  });

  test('repairs old snapshots by file name and removes unmatched private local links', () => {
    const recipientPath = path.join(os.tmpdir(), 'received', 'attachment-0.md');
    const legacy = [
      '[report.md](file:///E:/sender/report.md)',
      '[MEMORY.md](file:///C:/sender/openclaw/state/workspace-main/MEMORY.md)',
    ].join('\n');

    const restored = restoreConversationContentAttachmentLinks(legacy, [{
      name: 'report.md', sha256: 'a'.repeat(64),
    }], [recipientPath]);

    expect(restored).toContain(pathToFileURL(recipientPath).href);
    expect(restored).toContain('MEMORY.md');
    expect(restored).not.toContain('file:///C:/sender');
  });
});
