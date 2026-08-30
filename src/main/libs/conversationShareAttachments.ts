import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  SHARE_MAX_ATTACHMENT_BYTES,
  type SharePreviewAttachment,
} from '../../shared/conversationShare/constants';
import { stripDataUrlPrefix } from '../../shared/cowork/imageAttachments';
import type { CoworkMessage } from '../coworkStore';
import { t } from '../i18n';

const SHARE_MAX_ATTACHMENTS = 10;
const MARKDOWN_LOCAL_FILE_LINK_RE = /(!?\[[^\]]*\])\s*\(\s*<?(file:\/\/[^)\s>]+)>?(\s+["'][^"']*["'])?\s*\)/gi;
const MARKDOWN_SHARED_ATTACHMENT_LINK_RE = /(!?\[[^\]]*\])\s*\(\s*<?lfclaw-attachment:\/\/([a-f0-9]{64})>?(\s+["'][^"']*["'])?\s*\)/gi;
const MEDIA_LOCAL_FILE_TOKEN_RE = /\bMEDIA:\s*`?([^`\r\n]+?)`?[ \t]*$/gim;
const PRIVATE_AGENT_STATE_FILENAMES = new Set([
  'agents.md',
  'bootstrap.md',
  'heartbeat.md',
  'identity.md',
  'memory.md',
  'soul.md',
  'tools.md',
  'user.md',
]);

interface ImageAttachmentRecord {
  name?: unknown;
  base64Data?: unknown;
  localPath?: unknown;
}

interface LocalMediaAttachmentRecord {
  name?: unknown;
  localPath?: unknown;
}

export interface ConversationShareSourceAttachment extends SharePreviewAttachment {
  base64: string;
  sourcePaths: string[];
}

function extractMarkdownLocalFilePaths(content: string): string[] {
  const filePaths: string[] = [];
  const matcher = new RegExp(MARKDOWN_LOCAL_FILE_LINK_RE.source, MARKDOWN_LOCAL_FILE_LINK_RE.flags);
  for (const match of content.matchAll(matcher)) {
    try {
      const filePath = fileURLToPath(match[2]);
      if (filePath) filePaths.push(path.resolve(filePath));
    } catch {
      // Ignore malformed file URLs. Valid links that point to a missing file are
      // handled below as missing conversation attachments.
    }
  }
  return filePaths;
}

function mediaTokenLocalFilePath(value: string): string | null {
  let candidate = value.trim();
  if (candidate.length >= 2) {
    const first = candidate[0];
    const last = candidate[candidate.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      candidate = candidate.slice(1, -1).trim();
    }
  }
  if (/^file:\/\//i.test(candidate)) {
    try {
      return path.resolve(fileURLToPath(candidate));
    } catch {
      return null;
    }
  }
  return path.isAbsolute(candidate) ? path.resolve(candidate) : null;
}

function extractMediaTokenLocalFilePaths(content: string): string[] {
  const filePaths: string[] = [];
  const matcher = new RegExp(MEDIA_LOCAL_FILE_TOKEN_RE.source, MEDIA_LOCAL_FILE_TOKEN_RE.flags);
  for (const match of content.matchAll(matcher)) {
    const filePath = mediaTokenLocalFilePath(match[1]);
    if (filePath) filePaths.push(filePath);
  }
  return filePaths;
}

const normalizedPath = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const plainLinkLabel = (label: string): string => label.startsWith('!') ? label.slice(1) : label;

/** Remove sender-local paths from the immutable server snapshot. Shared files
 * use their content hash as a portable reference; private or missing local
 * links become plain labels instead of broken links that leak a disk path.
 */
export function prepareConversationContentForShare(
  content: string,
  attachments: ConversationShareSourceAttachment[],
): string {
  const bySourcePath = new Map<string, ConversationShareSourceAttachment>();
  for (const attachment of attachments) {
    for (const sourcePath of attachment.sourcePaths) {
      bySourcePath.set(normalizedPath(sourcePath), attachment);
    }
  }
  const portable = content.replace(MARKDOWN_LOCAL_FILE_LINK_RE, (_match, label: string, fileUrl: string, title = '') => {
    try {
      const attachment = bySourcePath.get(normalizedPath(fileURLToPath(fileUrl)));
      return attachment
        ? `${label}(lfclaw-attachment://${attachment.id}${title})`
        : plainLinkLabel(label);
    } catch {
      return plainLinkLabel(label);
    }
  });
  return portable.replace(MEDIA_LOCAL_FILE_TOKEN_RE, (match, value: string) => {
    const filePath = mediaTokenLocalFilePath(value);
    if (!filePath) return match;
    const attachment = bySourcePath.get(normalizedPath(filePath));
    const name = safeAttachmentName(path.basename(filePath), 'attachment');
    return attachment ? `[${name}](lfclaw-attachment://${attachment.id})` : name;
  });
}

/** Point portable attachment references at the recipient-local copies. The
 * file-name fallback repairs snapshots created by older LFClaw clients that
 * stored the sender's original file URL in the visible transcript.
 */
export function restoreConversationContentAttachmentLinks(
  content: string,
  attachments: Array<{ name: string; sha256: string }>,
  recipientPaths: string[],
): string {
  const byName = new Map<string, string[]>();
  for (const [index, attachment] of attachments.entries()) {
    const recipientPath = recipientPaths[index];
    if (!recipientPath) continue;
    const name = attachment.name.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), recipientPath]);
  }
  let restored = content.replace(MARKDOWN_LOCAL_FILE_LINK_RE, (_match, label: string, fileUrl: string, title = '') => {
    try {
      const candidates = byName.get(path.basename(fileURLToPath(fileUrl)).toLowerCase()) ?? [];
      return candidates.length === 1
        ? `${label}(${pathToFileURL(candidates[0]).href}${title})`
        : plainLinkLabel(label);
    } catch {
      return plainLinkLabel(label);
    }
  });
  for (const [index, attachment] of attachments.entries()) {
    const recipientPath = recipientPaths[index];
    if (!recipientPath) continue;
    restored = restored.replaceAll(
      `lfclaw-attachment://${attachment.sha256}`,
      pathToFileURL(recipientPath).href,
    );
  }
  restored = restored.replace(
    MARKDOWN_SHARED_ATTACHMENT_LINK_RE,
    (_match, label: string) => plainLinkLabel(label),
  );
  restored = restored.replace(MEDIA_LOCAL_FILE_TOKEN_RE, (match, value: string) => {
    const filePath = mediaTokenLocalFilePath(value);
    if (!filePath) return match;
    const name = safeAttachmentName(path.basename(filePath), 'attachment');
    const candidates = byName.get(name.toLowerCase()) ?? [];
    return candidates.length === 1 ? `[${name}](${pathToFileURL(candidates[0]).href})` : name;
  });
  return restored;
}

function isPrivateAgentStatePath(filePath: string): boolean {
  const normalized = path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
  if (PRIVATE_AGENT_STATE_FILENAMES.has(path.posix.basename(normalized))) return true;
  return /(?:^|\/)openclaw\/state\/workspace-[^/]+(?:\/|$)/.test(normalized)
    || /(?:^|\/)\.openclaw\/workspace(?:\/|$)/.test(normalized);
}

function safeAttachmentName(value: unknown, fallback: string): string {
  const source = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  const basename = path.basename(source).replace(/[\x00-\x1f/\\]/g, '_').trim();
  return (basename || fallback).slice(0, 200);
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  const normalized = stripDataUrlPrefix(value).replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const content = Buffer.from(normalized, 'base64');
  return content.toString('base64') === normalized ? content : null;
}

async function readLocalFile(filePath: string): Promise<Buffer | null> {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      if (stat.size > SHARE_MAX_ATTACHMENT_BYTES) throw new Error(t('shareTooLarge'));
      const content = await handle.readFile();
      return content.length === stat.size ? content : null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message === t('shareTooLarge')) throw error;
    return null;
  }
}

export async function collectConversationShareAttachments(
  messages: CoworkMessage[],
): Promise<ConversationShareSourceAttachment[]> {
  const attachments: ConversationShareSourceAttachment[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  const append = (name: string, content: Buffer, sourceKey: string, sourcePath?: string) => {
    if (seen.has(sourceKey)) return;
    if (!content.length) throw new Error(t('shareAttachmentMissing'));
    const nextTotal = totalBytes + content.length;
    if (attachments.length >= SHARE_MAX_ATTACHMENTS || nextTotal > SHARE_MAX_ATTACHMENT_BYTES) {
      throw new Error(t('shareTooLarge'));
    }
    seen.add(sourceKey);
    totalBytes = nextTotal;
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    attachments.push({
      id: digest,
      name,
      size: content.length,
      base64: content.toString('base64'),
      sourcePaths: sourcePath ? [sourcePath] : [],
    });
  };

  for (const message of messages) {
    const metadata = message.metadata;
    const imageRecords = metadata ? [
      ...(Array.isArray(metadata.imageAttachments) ? metadata.imageAttachments : []),
      ...(Array.isArray(metadata.imageAttachmentPreviews) ? metadata.imageAttachmentPreviews : []),
    ] as ImageAttachmentRecord[] : [];
    for (const [index, record] of imageRecords.entries()) {
      const localPath = typeof record.localPath === 'string' && record.localPath.trim()
        ? path.resolve(record.localPath)
        : '';
      if ((localPath && isPrivateAgentStatePath(localPath))
        || (!localPath && typeof record.name === 'string' && isPrivateAgentStatePath(record.name))) {
        continue;
      }
      const sourceKey = localPath
        ? `file:${process.platform === 'win32' ? localPath.toLowerCase() : localPath}`
        : `data:${crypto.createHash('sha256').update(String(record.base64Data ?? '')).digest('hex')}`;
      if (seen.has(sourceKey)) continue;
      const localContent = localPath ? await readLocalFile(localPath) : null;
      const content = localContent ?? decodeBase64(record.base64Data);
      if (!content) throw new Error(t('shareAttachmentMissing'));
      append(safeAttachmentName(record.name, `image-${index + 1}`), content, sourceKey, localPath || undefined);
    }

    const mediaRecords = Array.isArray(metadata?.localMediaAttachments)
      ? metadata.localMediaAttachments as LocalMediaAttachmentRecord[]
      : [];
    for (const [index, record] of mediaRecords.entries()) {
      if (typeof record.localPath !== 'string' || !record.localPath.trim()) {
        throw new Error(t('shareAttachmentMissing'));
      }
      const localPath = path.resolve(record.localPath);
      if (isPrivateAgentStatePath(localPath)) continue;
      const sourceKey = `file:${process.platform === 'win32' ? localPath.toLowerCase() : localPath}`;
      if (seen.has(sourceKey)) continue;
      const content = await readLocalFile(localPath);
      if (!content) throw new Error(t('shareAttachmentMissing'));
      append(safeAttachmentName(record.name, path.basename(localPath) || `attachment-${index + 1}`), content, sourceKey, localPath);
    }

    for (const localPath of extractMarkdownLocalFilePaths(message.content)) {
      if (isPrivateAgentStatePath(localPath)) continue;
      const sourceKey = `file:${process.platform === 'win32' ? localPath.toLowerCase() : localPath}`;
      if (seen.has(sourceKey)) continue;
      const content = await readLocalFile(localPath);
      if (!content) throw new Error(t('shareAttachmentMissing'));
      append(safeAttachmentName(path.basename(localPath), 'attachment'), content, sourceKey, localPath);
    }

    for (const localPath of extractMediaTokenLocalFilePaths(message.content)) {
      if (isPrivateAgentStatePath(localPath)) continue;
      const sourceKey = `file:${process.platform === 'win32' ? localPath.toLowerCase() : localPath}`;
      if (seen.has(sourceKey)) continue;
      const content = await readLocalFile(localPath);
      if (!content) throw new Error(t('shareAttachmentMissing'));
      append(safeAttachmentName(path.basename(localPath), 'attachment'), content, sourceKey, localPath);
    }
  }

  return attachments;
}
