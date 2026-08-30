import { describe, expect, test } from 'vitest';

import {
  CONVERSATION_SHARE_PAGE_SIZE,
  paginateConversationShares,
} from './conversationSharePagination';

describe('paginateConversationShares', () => {
  test('splits thirty inbox items across six bounded pages', () => {
    const items = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(CONVERSATION_SHARE_PAGE_SIZE).toBe(5);
    expect(paginateConversationShares(items, 1).items).toEqual(items.slice(0, 5));
    expect(paginateConversationShares(items, 2).items).toEqual(items.slice(5, 10));
    expect(paginateConversationShares(items, 6)).toEqual({
      items: items.slice(25),
      page: 6,
      pageCount: 6,
    });
  });

  test('clamps the current page after deletion', () => {
    const items = Array.from({ length: 5 }, (_, index) => index);
    expect(paginateConversationShares(items, 2).page).toBe(1);
  });
});
