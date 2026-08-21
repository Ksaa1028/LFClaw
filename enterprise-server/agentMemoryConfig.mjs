export const agentMemoryDefault = () => ({
  enabled: false,
  enterpriseCode: 'longfeng',
  coreUrl: '',
  serviceId: 'default',
  adminUserKey: '',
  teamId: '',
  chatMemoryEnabled: false,
  employeeMappings: {},
});

export const normalizeAgentMemory = (input = {}, existing = {}) => {
  const source = input && typeof input === 'object' ? input : {};
  const previous = existing && typeof existing === 'object' ? existing : {};
  const next = { ...agentMemoryDefault(), ...previous };
  const adminUserKey = String(source.adminUserKey ?? '').trim();
  return {
    enabled: Boolean(source.enabled ?? next.enabled),
    enterpriseCode: String(source.enterpriseCode ?? next.enterpriseCode).trim() || 'longfeng',
    coreUrl: String(source.coreUrl ?? next.coreUrl).trim().replace(/\/+$/, ''),
    serviceId: String(source.serviceId ?? next.serviceId).trim() || 'default',
    adminUserKey: adminUserKey && !/^\*+$/.test(adminUserKey)
      ? adminUserKey
      : String(next.adminUserKey || ''),
    teamId: String(source.teamId ?? next.teamId).trim(),
    chatMemoryEnabled: Boolean(source.chatMemoryEnabled ?? next.chatMemoryEnabled),
    employeeMappings: source.employeeMappings && typeof source.employeeMappings === 'object'
      ? source.employeeMappings
      : (next.employeeMappings && typeof next.employeeMappings === 'object' ? next.employeeMappings : {}),
  };
};

export const redactAgentMemory = input => {
  const config = normalizeAgentMemory(input);
  return {
    ...config,
    adminUserKey: config.adminUserKey ? '********' : '',
    employeeMappings: Object.fromEntries(Object.entries(config.employeeMappings).map(([employeeId, mapping]) => [
      employeeId,
      { ...mapping, userKey: mapping?.userKey ? '********' : '' },
    ])),
    configured: Boolean(config.coreUrl && config.adminUserKey && config.teamId),
  };
};

export const agentMemoryConversationId = (config, employeeId) => (
  `${normalizeAgentMemory(config).enterpriseCode}:${String(employeeId || '').trim()}`
);

export const agentMemoryIsolation = (config, employeeMapping) => {
  const normalized = normalizeAgentMemory(config);
  const mapping = employeeMapping && typeof employeeMapping === 'object' ? employeeMapping : {};
  return {
    team_id: normalized.teamId,
    user_id: String(mapping.userId || ''),
    agent_id: String(mapping.agentId || ''),
    task_id: String(mapping.taskId || ''),
  };
};

export const agentMemoryHeaders = (config, employeeId, employeeMapping) => {
  const normalized = normalizeAgentMemory(config);
  const mapping = employeeMapping && typeof employeeMapping === 'object' ? employeeMapping : {};
  const userKey = String(mapping.userKey || '');
  return {
    authorization: `Bearer ${userKey}`,
    'content-type': 'application/json',
    'x-tdai-service-id': normalized.serviceId,
    'x-tdai-user-key': userKey,
    'x-team-id': normalized.teamId,
    'x-agent-id': String(mapping.agentId || normalized.agentId),
    'x-task-id': String(mapping.taskId || normalized.taskId),
    'x-conversation-id': agentMemoryConversationId(normalized, employeeId),
  };
};
