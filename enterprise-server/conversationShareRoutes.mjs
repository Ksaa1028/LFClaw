import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { ConversationShareStore, readShareBody, shareSummary } from './conversationShares.mjs';

const API = '/api/enterprise/conversation-shares';
const reply = (res, status, data, error) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(error ? { code: status, message: error } : { code: 0, data }));
};

export function createConversationShareRoutes({ directory, findEmployeeByToken }) {
  const store = new ConversationShareStore(directory);
  const browserSessions = new Map();
  const attempts = new Map();
  return async (req, res, url, data) => {
    const viewer = /^\/share\/([a-f0-9]{64})$/.test(url.pathname);
    if (!viewer && !url.pathname.startsWith(API) && url.pathname !== '/api/share/login') return false;
    try {
      if (viewer && req.method === 'GET') {
        const nonce = crypto.randomBytes(18).toString('base64');
        const html = await fs.readFile(new URL('./conversationShareViewer.html', import.meta.url), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
        res.end(html.replaceAll('__NONCE__', nonce));
        return true;
      }
      if (url.pathname === '/api/share/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress || 'unknown';
        const entry = attempts.get(key) || { started: Date.now(), count: 0 };
        if (Date.now() - entry.started > 300000) { entry.started = Date.now(); entry.count = 0; }
        entry.count++;
        if (attempts.size >= 1000 && !attempts.has(key)) attempts.delete(attempts.keys().next().value);
        attempts.set(key, entry);
        if (entry.count > 60) { reply(res, 429, null, 'Too many attempts. Try again later.'); return true; }
        const body = await readShareBody(req);
        const code = typeof body.activationCode === 'string' ? body.activationCode.trim().toUpperCase() : '';
        const employee = data.employees.find(e => e.activationCode === code && e.status === 'active');
        if (!employee) { reply(res, 401, null, 'Invalid activation code.'); return true; }
        const token = crypto.randomBytes(32).toString('hex');
        if (browserSessions.size >= 1000) browserSessions.delete(browserSessions.keys().next().value);
        browserSessions.set(token, employee.id);
        // A read-only credential: never returns model keys or changes device activation.
        reply(res, 200, { token });
        return true;
      }
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const clientEmployee = findEmployeeByToken(data, token);
      const employee = clientEmployee || data.employees.find(e => e.id === browserSessions.get(token));
      if (!employee || employee.status !== 'active') { reply(res, 401, null, 'Sign in to view this share.'); return true; }
      if (url.pathname === `${API}/recipients` && req.method === 'GET' && clientEmployee) {
        reply(res, 200, data.employees.filter(e => e.status === 'active' && e.id !== employee.id).map(e => ({
          id: e.id, name: e.employeeName, department: data.departments?.find(d => d.id === e.departmentId)?.name || '',
        })));
      } else if (url.pathname === API && req.method === 'POST' && clientEmployee) {
        const snapshot = await store.create(await readShareBody(req), employee, data.employees);
        reply(res, 200, shareSummary(snapshot));
      } else if (url.pathname === API && req.method === 'GET' && clientEmployee) {
        reply(res, 200, await store.inbox(employee));
      } else {
        const match = url.pathname.match(/^\/api\/enterprise\/conversation-shares\/([a-f0-9]{64})$/);
        if (match && req.method === 'GET') reply(res, 200, await store.read(match[1], employee));
        else if (match && req.method === 'DELETE' && clientEmployee) reply(res, 200, await store.dismiss(match[1], employee));
        else reply(res, 404, null, 'Share endpoint not found.');
      }
    } catch (error) {
      if (!error.status) console.error('[ConversationShare] Request failed:', error);
      reply(res, error.status || 500, null, error.status ? error.message : 'Share service unavailable. Please retry.');
    }
    return true;
  };
}
