import { describe, expect, test } from 'vitest';

import type { ShareRecipient } from '../../../shared/conversationShare/constants';
import { filterShareRecipients } from './recipientSearch';

const recipients: ShareRecipient[] = [
  { id: '1', name: '董杰', department: '营运一层' },
  { id: '2', name: '杨康', department: '真真利亚' },
  { id: '3', name: '尤清怡', department: '营运二层' },
];

describe('filterShareRecipients', () => {
  test('does not expose the employee directory before the user searches', () => {
    expect(filterShareRecipients(recipients, '')).toEqual([]);
    expect(filterShareRecipients(recipients, '   ')).toEqual([]);
  });

  test('returns only matching names or departments', () => {
    expect(filterShareRecipients(recipients, '杨康').map(person => person.id)).toEqual(['2']);
    expect(filterShareRecipients(recipients, '营运').map(person => person.id)).toEqual(['1', '3']);
  });
});
