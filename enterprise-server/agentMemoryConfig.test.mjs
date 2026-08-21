import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentMemoryDefault,
  agentMemoryHeaders,
  agentMemoryIsolation,
  normalizeAgentMemory,
  redactAgentMemory,
} from './agentMemoryConfig.mjs';

test('uses longfeng as the default enterprise code', () => {
  assert.equal(agentMemoryDefault().enterpriseCode, 'longfeng');
});

test('builds the v3 isolation body from the employee mapping', () => {
  assert.deepEqual(agentMemoryIsolation({ teamId: 'team-longfeng' }, {
    userId: 'usr-employee',
    agentId: 'agt-employee',
    taskId: 'task-employee',
  }), {
    team_id: 'team-longfeng',
    user_id: 'usr-employee',
    agent_id: 'agt-employee',
    task_id: 'task-employee',
  });
});

test('keeps the saved key when the masked value is submitted', () => {
  const result = normalizeAgentMemory(
    { adminUserKey: '********' },
    { adminUserKey: 'sk-mem-admin' },
  );
  assert.equal(result.adminUserKey, 'sk-mem-admin');
});

test('redacts the key returned to the admin page', () => {
  const result = redactAgentMemory({
    coreUrl: 'http://127.0.0.1:8420',
    adminUserKey: 'sk-mem-admin',
    teamId: 'team-longfeng',
  });
  assert.equal(result.adminUserKey, '********');
  assert.equal(result.configured, true);
});

test('requires the Core management connection before enabling automatic isolation', () => {
  const result = redactAgentMemory({
    adminUserKey: 'sk-mem-admin',
    teamId: 'team-longfeng',
  });
  assert.equal(result.configured, false);
});

test('builds proxy headers from the provisioned employee mapping', () => {
  const headers = agentMemoryHeaders({
    enterpriseCode: 'longfeng',
    serviceId: 'lfclaw',
    teamId: 'team-longfeng',
  }, 'employee-001', {
    userKey: 'sk-mem-employee',
    agentId: 'agt-employee',
    taskId: 'task-employee',
  });
  assert.equal(headers.authorization, 'Bearer sk-mem-employee');
  assert.equal(headers['x-tdai-service-id'], 'lfclaw');
  assert.equal(headers['x-tdai-user-key'], 'sk-mem-employee');
  assert.equal(headers['x-conversation-id'], 'longfeng:employee-001');
  assert.equal(headers['x-agent-id'], 'agt-employee');
  assert.equal(headers['x-task-id'], 'task-employee');
});
