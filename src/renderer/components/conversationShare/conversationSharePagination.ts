export const CONVERSATION_SHARE_PAGE_SIZE = 5;

export function paginateConversationShares<T>(items: T[], page: number): {
  items: T[];
  page: number;
  pageCount: number;
} {
  const pageCount = Math.max(1, Math.ceil(items.length / CONVERSATION_SHARE_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * CONVERSATION_SHARE_PAGE_SIZE;
  return {
    items: items.slice(start, start + CONVERSATION_SHARE_PAGE_SIZE),
    page: safePage,
    pageCount,
  };
}
