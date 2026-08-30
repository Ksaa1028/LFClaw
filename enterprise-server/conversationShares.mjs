import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ShareMode = { Link: 'link', Direct: 'direct' };
export const ShareRole = { User: 'user', Assistant: 'assistant' };
export const SHARE_BODY_LIMIT = 18 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/;
const reject = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const text = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit;
export const canReadShare = (share, employee) => employee?.status === 'active' && (
  share.sender.id === employee.id || share.mode === ShareMode.Link || share.recipientIds.includes(employee.id)
);
export const shareSummary = ({ id, title, sender, createdAt, mode, recipientIds, messageCount }) => (
  { id, title, sender, createdAt, mode, recipientIds, messageCount }
);

export function normalizeShare(input, employee, employees) {
  if (!input || !text(input.title, 200) || !Object.values(ShareMode).includes(input.mode)) reject('Invalid share.');
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 2000) reject('Select between 1 and 2000 messages.');
  let textBytes = 0;
  const ids = new Set();
  const messages = input.messages.map(message => {
    if (!message || !text(message.id, 100) || ids.has(message.id) || !Object.values(ShareRole).includes(message.role)
      || typeof message.content !== 'string' || !Number.isFinite(message.timestamp)) reject('Invalid message.');
    ids.add(message.id);
    textBytes += Buffer.byteLength(message.content);
    return { id: message.id, role: message.role, content: message.content, timestamp: message.timestamp };
  });
  if (textBytes > 2 * 1024 * 1024) reject('Selected messages exceed 2 MB.');
  if (!Array.isArray(input.recipientIds) || input.recipientIds.length > 100) reject('Invalid recipients.');
  const recipientIds = [...new Set(input.recipientIds)];
  if (input.mode === ShareMode.Direct && (!recipientIds.length || recipientIds.some(id => !employees.some(e => e.id === id && e.status === 'active')))) reject('Recipient is unavailable.');
  if (!Array.isArray(input.attachments) || input.attachments.length > 10) reject('At most 10 attachments are allowed.');
  let bytes = 0;
  const attachments = input.attachments.map((attachment, index) => {
    if (!attachment || !text(attachment.name, 200) || /[\x00-\x1f\/\\]/.test(attachment.name)
      || typeof attachment.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.base64)) reject('Invalid attachment.');
    const buffer = Buffer.from(attachment.base64, 'base64');
    bytes += buffer.length;
    if (buffer.toString('base64') !== attachment.base64 || bytes > 10 * 1024 * 1024) reject('Attachments exceed 10 MB or are invalid.');
    return { id: String(index), name: attachment.name, size: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), base64: attachment.base64 };
  });
  return {
    schemaVersion: 1, title: input.title.trim(), mode: input.mode,
    sender: { id: employee.id, name: employee.employeeName },
    recipientIds: input.mode === ShareMode.Direct ? recipientIds : [],
    createdAt: Date.now(), messages, messageCount: messages.length, attachments,
  };
}

export class ConversationShareStore {
  constructor(directory) { this.directory = directory; }
  dismissalPath(id, employee) {
    const recipient = crypto.createHash('sha256').update(employee.id).digest('hex');
    return path.join(this.directory, '.dismissed', recipient, id);
  }
  async isDismissed(id, employee) {
    try { await fs.access(this.dismissalPath(id, employee)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async readPublished(id) {
    if (!ID.test(id)) reject('Share not found.', 404);
    try { return JSON.parse(await fs.readFile(path.join(this.directory, id, 'snapshot.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') reject('Share not found.', 404); throw error; }
  }
  async create(input, employee, employees) {
    if (!text(input.requestId, 100) || !/^[a-zA-Z0-9-]+$/.test(input.requestId)) reject('Invalid request ID.');
    const normalized = normalizeShare(input, employee, employees);
    // Stable, unguessable ID makes a timed-out publish retry idempotent.
    const id = crypto.createHash('sha256').update(employee.id + ':' + input.requestId).digest('hex');
    const snapshot = { ...normalized, id };
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, id);
    try {
      await fs.access(path.join(target, 'snapshot.json'));
      const existing = await this.read(id, employee);
      if (JSON.stringify({ ...existing, createdAt: 0 }) !== JSON.stringify({ ...snapshot, createdAt: 0 })) reject('Request already used for different content.', 409);
      return existing;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const staging = await fs.mkdtemp(path.join(this.directory, '.pending-'));
    try {
      await fs.writeFile(path.join(staging, 'snapshot.json'), JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
      await fs.writeFile(path.join(staging, 'summary.json'), JSON.stringify(shareSummary(snapshot)), { flag: 'wx', mode: 0o600 });
      try { await fs.rename(staging, target); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        const existing = await this.read(id, employee);
        if (JSON.stringify({ ...existing, createdAt: 0 }) !== JSON.stringify({ ...snapshot, createdAt: 0 })) reject('Request already used.', 409);
        return existing;
      }
      return snapshot;
    } finally {
      // Only this operation's generated staging directory, never a published snapshot.
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
  async read(id, employee) {
    const snapshot = await this.readPublished(id);
    if (!canReadShare(snapshot, employee)) reject('Share not found or not authorized.', 403);
    if (snapshot.mode === ShareMode.Direct && snapshot.recipientIds.includes(employee.id)
      && await this.isDismissed(id, employee)) reject('Share was deleted from this inbox.', 404);
    return snapshot;
  }
  async dismiss(id, employee) {
    const snapshot = await this.readPublished(id);
    if (snapshot.mode !== ShareMode.Direct || !snapshot.recipientIds.includes(employee.id)) {
      reject('Only a recipient can delete this inbox item.', 403);
    }
    const marker = this.dismissalPath(id, employee);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, String(Date.now()), { flag: 'a', mode: 0o600 });
    return { deleted: true };
  }
  async inbox(employee) {
    let entries;
    try { entries = await fs.readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const summaries = [];
    for (const id of entries.filter(name => ID.test(name))) {
      const summary = JSON.parse(await fs.readFile(path.join(this.directory, id, 'summary.json'), 'utf8'));
      if (summary.mode === ShareMode.Direct && summary.recipientIds.includes(employee.id)
        && canReadShare(summary, employee) && !await this.isDismissed(id, employee)) summaries.push(summary);
    }
    return summaries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }
}

export async function readShareBody(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > SHARE_BODY_LIMIT) reject('Share is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject('Invalid JSON.'); }
}
