import { BrowserWindow, ipcMain } from 'electron';

import { ConversationShareIpc } from '../../shared/conversationShare/constants';

let pendingLink: string | null = null;
export function queueConversationShareLink(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'lobsterai:' || url.hostname !== 'conversation-share') return false;
  if (!/^\/[a-f0-9]{64}$/.test(url.pathname)) return true;
  try {
    const server = new URL(url.searchParams.get('server') || '');
    if (!['https:', 'http:'].includes(server.protocol) || server.username || server.password) return true;
    pendingLink = `${server.origin}/share${url.pathname}`;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(ConversationShareIpc.LinkAvailable);
    }
  } catch { /* Invalid links never reach authentication or model execution. */ }
  return true;
}

export function registerConversationShareLinks(): void {
  ipcMain.handle(ConversationShareIpc.PendingLink, () => {
    const value = pendingLink;
    pendingLink = null;
    return value;
  });
}
