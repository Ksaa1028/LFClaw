import {
  agentMemoryConversationId,
  agentMemoryHeaders,
  agentMemoryIsolation,
} from './agentMemoryConfig.mjs';

const AUDIT_REQUESTS = [
  ['l0', 'conversation/query', { limit: 100, offset: 0 }],
  ['l1', 'atomic/query', { limit: 100, offset: 0 }],
  ['l2', 'scenario/ls', {}],
  ['l3', 'core/read', {}],
];

const requestLayer = async ({ config, employee, mapping, layer, action, body, fetchImpl }) => {
  const response = await fetchImpl(`${config.coreUrl}/v3/${action}`, {
    method: 'POST',
    headers: agentMemoryHeaders(config, employee.employeeId, mapping),
    body: JSON.stringify({
      ...agentMemoryIsolation(config, mapping),
      ...body,
      ...(layer === 'l0' || layer === 'l1'
        ? { session_id: agentMemoryConversationId(config, employee.employeeId) }
        : {}),
    }),
  });
  const text = await response.text();
  let envelope = {};
  try { envelope = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok || Number(envelope.code) !== 0) {
    throw new Error(envelope.message || `Agent Memory ${action} failed (HTTP ${response.status})`);
  }
  return envelope.data ?? {};
};

export const readAgentMemoryAudit = async ({ config, employee, mapping, fetchImpl = fetch }) => {
  const entries = await Promise.all(AUDIT_REQUESTS.map(async ([layer, action, body]) => [
    layer,
    await requestLayer({ config, employee, mapping, layer, action, body, fetchImpl }),
  ]));
  return Object.fromEntries(entries);
};
