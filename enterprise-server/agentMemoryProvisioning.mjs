import crypto from 'crypto';

const cleanUrl = value => String(value || '').trim().replace(/\/+$/, '');
const clean = value => String(value || '').trim();

const stableHubUserId = (enterpriseCode, employeeId) => {
  const digest = crypto.createHash('sha256')
    .update(`${clean(enterpriseCode)}:${clean(employeeId)}`)
    .digest('hex')
    .slice(0, 24);
  return `usr-lfclaw-${digest}`;
};
const metadataRequest = async (config, userKey, action, body, fetchImpl = fetch) => {
  const response = await fetchImpl(`${cleanUrl(config.coreUrl)}/v3/meta/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tdai-service-id': clean(config.serviceId) || 'default',
      'x-tdai-user-key': clean(userKey),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let envelope;
  try {
    envelope = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Agent Memory ${action} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || Number(envelope.code) !== 0) {
    const error = new Error(envelope.message || `Agent Memory ${action} failed (HTTP ${response.status})`);
    error.status = response.status;
    error.code = envelope.code;
    throw error;
  }
  return envelope.data || {};
};

const ignoreConflict = async operation => {
  try {
    return await operation();
  } catch (error) {
    if (Number(error?.status) === 409 || Number(error?.code) === 409) return null;
    throw error;
  }
};

export const provisionAgentMemoryEmployee = async ({
  config,
  employee,
  existing = {},
  fetchImpl = fetch,
}) => {
  if (existing.userKey && existing.userId && existing.agentId && existing.taskId) return existing;

  const employeeId = clean(employee?.employeeId);
  if (!employeeId) throw new Error('LFCLAW employeeId is required for Agent Memory provisioning.');
  if (!clean(config?.coreUrl) || !clean(config?.adminUserKey) || !clean(config?.teamId)) {
    throw new Error('Agent Memory provisioning requires Core URL, system admin User_Key and Team ID.');
  }

  const userId = clean(existing.userId) || stableHubUserId(config.enterpriseCode, employeeId);
  let userKey = clean(existing.userKey);
  if (!userKey) {
    const created = await ignoreConflict(() => metadataRequest(
      config,
      config.adminUserKey,
      'user/create',
      { user_id: userId, username: `lfclaw-${employeeId}` },
      fetchImpl,
    ));
    userKey = clean(created?.default_user_key);
    if (!userKey) {
      const key = await metadataRequest(
        config,
        config.adminUserKey,
        'user-key/create',
        { user_id: userId, name: 'LFCLAW enterprise access' },
        fetchImpl,
      );
      userKey = clean(key.key_value || key.user_key || key.default_user_key);
    }
  }
  if (!userKey) throw new Error('Agent Memory did not return an employee User_Key.');

  await ignoreConflict(() => metadataRequest(
    config,
    config.adminUserKey,
    'team-member/add',
    { team_id: config.teamId, user_id: userId, role: 'member' },
    fetchImpl,
  ));

  let agentId = clean(existing.agentId);
  if (!agentId) {
    const agent = await metadataRequest(config, userKey, 'agent/create', {
      team_id: config.teamId,
      owner_user_id: userId,
      name: `LFCLAW-${employeeId}`,
      description: `LFCLAW employee private memory for ${employeeId}`,
      visibility: 'private',
      metadata_json: JSON.stringify({ source: 'lfclaw', employee_id: employeeId }),
    }, fetchImpl);
    agentId = clean(agent.agent_id);
  }
  if (!agentId) throw new Error('Agent Memory did not return an employee Agent ID.');

  let taskId = clean(existing.taskId);
  if (!taskId) {
    const task = await metadataRequest(config, userKey, 'task/create', {
      team_id: config.teamId,
      creator_user_id: userId,
      title: `LFCLAW-${employeeId}-memory`,
      description: 'LFCLAW employee private conversation memory',
      source_type: 'manual',
      status: 'running',
      linked_agents: [{ agent_id: agentId, role_in_task: 'owner' }],
      metadata_json: JSON.stringify({ source: 'lfclaw', employee_id: employeeId }),
    }, fetchImpl);
    taskId = clean(task.task_id);
  }
  if (!taskId) throw new Error('Agent Memory did not return an employee Task ID.');

  return {
    userId,
    userKey,
    agentId,
    taskId,
    provisionedAt: new Date().toISOString(),
  };
};
