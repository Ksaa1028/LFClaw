import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentMemorySearchQuery,
  assistantTextFromResponse,
  cleanAgentMemoryUserText,
  injectAgentMemoryContext,
  latestUserText,
  recallAgentMemory,
  rememberAgentMemoryTurn,
  upstreamModelUrl,
} from './agentMemoryConversation.mjs';

test('extracts the latest user message from OpenAI-compatible input', () => {
  assert.equal(latestUserText({ messages: [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: [{ type: 'text', text: 'new fact' }] },
  ] }), 'new fact');
});

test('keeps only the real request from an OpenClaw-wrapped user message', () => {
  assert.equal(cleanAgentMemoryUserText(`Sender metadata\n[LFClaw system instructions]\nnoise\n\n[Current user request]\n我最爱喝桂花乌龙`), '我最爱喝桂花乌龙');
});

test('keeps Agent Memory search queries under the upstream limit', () => {
  const query = agentMemorySearchQuery(`first ${'x'.repeat(2500)} last`);
  assert.equal(query.length <= 1800, true);
  assert.equal(query.endsWith('last'), true);
});

test('injects recalled memory without changing the selected model', () => {
  const result = injectAgentMemoryContext({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
  }, '用户偏好中文');
  assert.equal(result.model, 'deepseek-chat');
  assert.equal(result.messages[0].role, 'system');
  assert.match(result.messages[0].content, /用户偏好中文/);
});

test('avoids duplicating the v1 segment in upstream URLs', () => {
  assert.equal(
    upstreamModelUrl('https://example.com/compatible-mode/v1', '/v1/chat/completions'),
    'https://example.com/compatible-mode/v1/chat/completions',
  );
});

test('maps client v1 requests to the BigModel v4 API without an extra version', () => {
  for (const base of [
    'https://open.bigmodel.cn/api/paas/v4',
    'https://open.bigmodel.cn/api/paas/v4/',
  ]) {
    for (const suffix of ['v1/chat/completions', '/v1/chat/completions', 'chat/completions']) {
      assert.equal(
        upstreamModelUrl(base, suffix),
        'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      );
    }
  }
});

test('preserves existing URL routing for other providers and API paths', () => {
  const cases = [
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', '/v1/chat/completions', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'],
    ['https://api.openai.com/v1/', 'v1/chat/completions', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.deepseek.com', 'v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions'],
    ['https://example.com/custom', 'v1/chat/completions', 'https://example.com/custom/v1/chat/completions'],
    ['https://example.com/api/paas/v4', 'v1/chat/completions', 'https://example.com/api/paas/v4/v1/chat/completions'],
    ['https://open.bigmodel.cn/api/anthropic', 'v1/messages', 'https://open.bigmodel.cn/api/anthropic/v1/messages'],
    ['https://open.bigmodel.cn/api/paas/v4', 'embeddings', 'https://open.bigmodel.cn/api/paas/v4/embeddings'],
  ];
  for (const [base, suffix, expected] of cases) {
    assert.equal(upstreamModelUrl(base, suffix), expected);
  }
});

test('collects assistant text from an OpenAI-compatible event stream', () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"你"}}]}',
    'data: {"choices":[{"delta":{"content":"好"}}]}',
    'data: [DONE]',
  ].join('\n\n');
  assert.equal(assistantTextFromResponse(body, 'text/event-stream'), '你好');
});

test('keeps remote memory requests isolated by employee', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { items: [] } }),
    };
  };
  const config = {
    enterpriseCode: 'longfeng',
    coreUrl: 'https://memory.example.com',
    serviceId: 'default',
    teamId: 'team-1',
  };
  const alice = { employeeId: 'alice' };
  const bob = { employeeId: 'bob' };

  await recallAgentMemory({
    config,
    employee: alice,
    mapping: { userKey: 'key-alice', userId: 'user-alice', agentId: 'agent-alice', taskId: 'task-alice' },
    query: '我的偏好',
    fetchImpl,
  });
  await rememberAgentMemoryTurn({
    config,
    employee: bob,
    mapping: { userKey: 'key-bob', userId: 'user-bob', agentId: 'agent-bob', taskId: 'task-bob' },
    userText: '我的习惯',
    assistantText: '已记住',
    fetchImpl,
  });

  assert.equal(requests[0].headers['x-tdai-user-key'], 'key-alice');
  assert.equal(requests[0].headers['x-conversation-id'], 'longfeng:alice');
  assert.equal(requests[0].body.session_id, 'longfeng:alice');
  assert.equal(requests[0].body.team_id, 'team-1');
  assert.equal(requests[0].body.user_id, 'user-alice');
  assert.equal(requests[0].body.agent_id, 'agent-alice');
  assert.equal(requests[1].headers['x-tdai-user-key'], 'key-bob');
  assert.equal(requests[1].headers['x-conversation-id'], 'longfeng:bob');
  assert.equal(requests[1].body.session_id, 'longfeng:bob');
  assert.equal(requests[1].body.team_id, 'team-1');
  assert.equal(requests[1].body.user_id, 'user-bob');
  assert.equal(requests[1].body.agent_id, 'agent-bob');
});

test('skips intermediate responses and deduplicates completed turns', async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) };
  };
  const input = {
    config: { enterpriseCode: 'longfeng', coreUrl: 'https://memory.example.com', serviceId: 'default', teamId: 'team-1' },
    employee: { employeeId: 'dedup-user' },
    mapping: { userKey: 'key', userId: 'user', agentId: 'agent-dedup', taskId: 'task' },
    userText: 'context\n[Current user request]\n记住桂花乌龙',
    fetchImpl,
  };
  await rememberAgentMemoryTurn({ ...input, assistantText: '' });
  await rememberAgentMemoryTurn({ ...input, assistantText: '已经记住' });
  await rememberAgentMemoryTurn({ ...input, assistantText: '重复回答' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].messages[0].content, '记住桂花乌龙');
  assert.equal(requests[0].messages[1].content, '已经记住');
});
