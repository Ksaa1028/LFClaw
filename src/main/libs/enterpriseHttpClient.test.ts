import { beforeEach, describe, expect, test, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: fetchMock } }));

import { fetchEnterprise } from './enterpriseHttpClient';

describe('fetchEnterprise', () => {
  beforeEach(() => fetchMock.mockReset());

  test('retries a GET once after a retryable response', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const response = await fetchEnterprise('https://enterprise.test/me', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not retry POST requests', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchEnterprise('https://enterprise.test/usage', { method: 'POST' })).rejects.toThrow('offline');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not retry non-retryable HTTP responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const response = await fetchEnterprise('https://enterprise.test/me', { method: 'GET' });
    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
