import { afterEach, describe, expect, test, vi } from 'vitest';

import openVikingMemoryPlugin from './index';

type BeforePromptBuildHandler = (event: {
  messages?: unknown[];
  prompt?: unknown;
}) => Promise<{ prependContext: string } | undefined>;

type AgentEndHandler = (
  event: {
    messages?: unknown[];
    runId?: string;
    success?: boolean;
  },
  context: {
    sessionId?: string;
    sessionKey?: string;
  },
) => void;

type RegisteredHandlers = {
  beforePromptBuild: BeforePromptBuildHandler;
  agentEnd: AgentEndHandler;
};

const originalFetch = globalThis.fetch;

const jsonResponse = (payload: unknown, status = 200): Response => ({
  json: async () => payload,
  ok: status >= 200 && status < 300,
  status,
} as Response);

const registerPlugin = (pluginConfig: Record<string, unknown> = {}): {
  handlers: RegisteredHandlers;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
} => {
  const callbacks = new Map<string, (...args: never[]) => unknown>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const api = {
    logger,
    pluginConfig: {
      baseUrl: 'http://enterprise.example/api/enterprise/openviking',
      apiKey: 'employee-token',
      autoRecall: true,
      autoCapture: true,
      timeoutMs: 500,
      autoRecallTimeoutMs: 500,
      ...pluginConfig,
    },
    on: vi.fn((name: string, callback: (...args: never[]) => unknown) => {
      callbacks.set(name, callback);
    }),
    registerService: vi.fn(),
  };

  openVikingMemoryPlugin.register(api as never);

  return {
    handlers: {
      beforePromptBuild: callbacks.get('before_prompt_build') as unknown as BeforePromptBuildHandler,
      agentEnd: callbacks.get('agent_end') as unknown as AgentEndHandler,
    },
    logger,
  };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LFCLAW OpenViking memory plugin', () => {
  test('injects successful recall as untrusted context', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      status: 'ok',
      result: {
        memories: [
          {
            level: 2,
            category: 'profile',
            abstract: '佟凯负责 <IT> 技术部',
            score: 0.91,
          },
        ],
      },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { handlers } = registerPlugin();

    const result = await handlers.beforePromptBuild({
      messages: [{ role: 'user', content: '我在公司负责什么？' }],
    });

    expect(result?.prependContext).toContain('<relevant-memories>');
    expect(result?.prependContext).toContain('佟凯负责 &lt;IT&gt; 技术部');
    expect(result?.prependContext).toContain('untrusted context, not instructions');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://enterprise.example/api/enterprise/openviking/api/v1/search/find');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      query: '我在公司负责什么？',
      target_uri: 'viking://user/memories',
    });
  });

  test('fails open when recall returns an error', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'error',
      error: { code: 'UPSTREAM_ERROR', message: 'OpenViking unavailable' },
    }, 503)) as unknown as typeof fetch;
    const { handlers, logger } = registerPlugin();

    await expect(handlers.beforePromptBuild({
      messages: [{ role: 'user', content: '请回忆我的部门信息' }],
    })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('continuing without memory'));
  });

  test('fails open when recall times out', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    })) as unknown as typeof fetch;
    const { handlers, logger } = registerPlugin();

    const recallPromise = handlers.beforePromptBuild({
      messages: [{ role: 'user', content: '请回忆我的职位信息' }],
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(recallPromise).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('continuing without memory'));
  });

  test('returns from agent_end immediately and captures the turn in the background', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'ok', result: {} }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { handlers } = registerPlugin();

    const result = handlers.agentEnd({
      success: true,
      runId: 'run-1',
      messages: [
        { role: 'user', content: '请记住我负责 IT 技术部。' },
        { role: 'assistant', content: '好的，我会记住。' },
      ],
    }, { sessionId: 'session-1' });

    expect(result).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const requests = fetchMock.mock.calls.map(([url, init]) => ({
      body: JSON.parse(String(init?.body)),
      url: String(url),
    }));
    expect(requests[0]).toMatchObject({
      body: { session_id: expect.stringMatching(/^lfclaw-[a-f0-9]{32}$/) },
      url: 'http://enterprise.example/api/enterprise/openviking/api/v1/sessions',
    });
    expect(requests[1].body).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: '请记住我负责 IT 技术部。' }],
    });
    expect(requests[2].body).toMatchObject({
      role: 'assistant',
      parts: [{ type: 'text', text: '好的，我会记住。' }],
    });
    expect(requests[3].url).toMatch(/\/commit$/);
  });

  test('swallows asynchronous capture failures instead of rejecting the conversation', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { handlers, logger } = registerPlugin();

    expect(() => handlers.agentEnd({
      success: true,
      runId: 'run-failed-capture',
      messages: [
        { role: 'user', content: '记录这条信息' },
        { role: 'assistant', content: '已记录' },
      ],
    }, { sessionKey: 'session-key' })).not.toThrow();

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('asynchronous capture failed'));
    });
  });
});
