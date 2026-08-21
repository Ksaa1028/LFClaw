import assert from 'node:assert/strict';
import test from 'node:test';

import { provisionAgentMemoryEmployee } from './agentMemoryProvisioning.mjs';

const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(status === 200
    ? { code: 0, data }
    : { code: status, message: 'conflict' }),
});

test('provisions a private Hub user, membership, Agent and Task for an LFCLAW employee', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const action = String(url).split('/v3/meta/')[1];
    const body = JSON.parse(options.body);
    calls.push({ action, body, headers: options.headers });
    if (action === 'user/create') return response({ user_id: body.user_id, default_user_key: 'sk-employee' });
    if (action === 'team-member/add') return response({});
    if (action === 'agent/create') return response({ agent_id: 'agt-employee' });
    if (action === 'task/create') return response({ task_id: 'task-employee' });
    throw new Error(`unexpected action: ${action}`);
  };

  const mapping = await provisionAgentMemoryEmployee({
    config: {
      enterpriseCode: 'longfeng',
      coreUrl: 'http://127.0.0.1:8420',
      serviceId: 'default',
      adminUserKey: 'sk-admin',
      teamId: 'team-longfeng',
    },
    employee: { employeeId: '0814' },
    fetchImpl,
  });

  assert.equal(mapping.userKey, 'sk-employee');
  assert.equal(mapping.agentId, 'agt-employee');
  assert.equal(mapping.taskId, 'task-employee');
  assert.match(mapping.userId, /^usr-lfclaw-[0-9a-f]{24}$/);
  assert.deepEqual(calls.map(call => call.action), [
    'user/create',
    'team-member/add',
    'agent/create',
    'task/create',
  ]);
  assert.equal(calls[2].headers['x-tdai-user-key'], 'sk-employee');
  assert.equal(calls[3].body.linked_agents[0].agent_id, 'agt-employee');
});

test('returns an existing complete mapping without calling Memory Core', async () => {
  const existing = {
    userId: 'usr-existing',
    userKey: 'sk-existing',
    agentId: 'agt-existing',
    taskId: 'task-existing',
  };
  const result = await provisionAgentMemoryEmployee({
    config: {},
    employee: { employeeId: '0814' },
    existing,
    fetchImpl: async () => { throw new Error('must not call'); },
  });
  assert.equal(result, existing);
});
