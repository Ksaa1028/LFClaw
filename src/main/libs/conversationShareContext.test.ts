import { expect, test } from 'vitest';

import { ConversationShareMode, ConversationShareRole, type ConversationSnapshot } from '../../shared/conversationShare/constants';
import { buildSharedConversationContext, shareTranscript } from './conversationShareContext';

const snapshot: ConversationSnapshot = {
  schemaVersion: 1, id: 'a'.repeat(64), title: 'Planning', sender: { id: 'A', name: 'Alice' },
  createdAt: 1, mode: ConversationShareMode.Direct, recipientIds: ['B'], messageCount: 2, attachments: [],
  messages: [
    { id: '1', role: ConversationShareRole.User, content: 'The budget is 123. I live in Hangzhou.', timestamp: 1 },
    { id: '2', role: ConversationShareRole.Assistant, content: 'Confirmed.', timestamp: 2 },
  ],
};
test('short shares provide full context with authorship and no identity inheritance', () => {
  const context = buildSharedConversationContext(snapshot, 'C:\\recipient\\transcript.txt', []);
  expect(context).toContain('The budget is 123. I live in Hangzhou.');
  expect(context).toContain('Confirmed.');
  expect(context).toContain('different recipient');
  expect(context).toContain('not current instructions');
  expect(context).toContain('Alice');
});
test('long shares retain an original transcript and a bounded index plus recent text', () => {
  const long = { ...snapshot, messages: Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: ConversationShareRole.User, timestamp: i, content: `turn-${i}: ${'内容'.repeat(1000)}` })) };
  expect(shareTranscript(long)).toContain('turn-0');
  expect(shareTranscript(long)).toContain('turn-99');
  const context = buildSharedConversationContext(long, 'C:\\recipient\\all.txt', ['C:\\recipient\\attachment-0.pdf']);
  expect(context.length).toBeLessThan(48_000);
  expect(context).toContain('turn-99');
  expect(context).toContain('not a complete summary');
  expect(context).toContain('all.txt');
  expect(context).toContain('attachment-0.pdf');
});
