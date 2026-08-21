import assert from 'node:assert/strict';
import test from 'node:test';

import { readAgentMemoryAudit } from './agentMemoryAudit.mjs';

test('admin audit reads every memory layer with employee isolation credentials', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 0, data: { source: url } }), { status: 200 });
  };
  const result = await readAgentMemoryAudit({
    config: { coreUrl: 'http://memory.example', serviceId: 'svc', teamId: 'team', enterpriseCode: 'longfeng' },
    employee: { employeeId: 'alice' },
    mapping: {
      userKey: 'employee-key', userId: 'user-alice', agentId: 'agent-alice', taskId: 'task-alice',
    },
    fetchImpl,
  });
  assert.deepEqual(Object.keys(result), ['l0', 'l1', 'l2', 'l3']);
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.headers['x-tdai-user-key'], 'employee-key');
    assert.equal(request.headers['x-agent-id'], 'agent-alice');
    assert.equal(request.headers['x-team-id'], 'team');
    assert.equal(request.body.team_id, 'team');
    assert.equal(request.body.user_id, 'user-alice');
    assert.equal(request.body.agent_id, 'agent-alice');
    assert.equal(request.body.task_id, 'task-alice');
  }
  assert.equal(requests[0].body.session_id, 'longfeng:alice');
  assert.equal(requests[1].body.session_id, 'longfeng:alice');
  assert.equal(requests[2].body.session_id, undefined);
  assert.equal(requests[3].body.session_id, undefined);
});
