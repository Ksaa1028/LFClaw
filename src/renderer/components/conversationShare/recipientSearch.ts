import type { ShareRecipient } from '../../../shared/conversationShare/constants';

export function filterShareRecipients(
  recipients: ShareRecipient[],
  search: string,
): ShareRecipient[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return [];
  return recipients.filter((person) => (
    `${person.name} ${person.department || ''}`.toLocaleLowerCase().includes(query)
  ));
}
