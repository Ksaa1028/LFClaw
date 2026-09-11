import { net } from 'electron';

const ENTERPRISE_REQUEST_TIMEOUT_MS = 12_000;
const ENTERPRISE_GET_RETRY_DELAY_MS = 300;
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

const delay = (milliseconds: number): Promise<void> => (
  new Promise(resolve => setTimeout(resolve, milliseconds))
);

export const fetchEnterprise = async (
  url: string,
  init: RequestInit & { method: 'GET' | 'POST' },
): Promise<Response> => {
  const attempts = init.method === 'GET' ? 2 : 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENTERPRISE_REQUEST_TIMEOUT_MS);
    try {
      const response = await net.fetch(url, { ...init, signal: controller.signal });
      if (attempt + 1 < attempts && RETRYABLE_STATUS_CODES.has(response.status)) {
        await response.body?.cancel().catch((): void => undefined);
        await delay(ENTERPRISE_GET_RETRY_DELAY_MS);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts) {
        if (controller.signal.aborted) {
          throw new Error(`Enterprise request timed out after ${ENTERPRISE_REQUEST_TIMEOUT_MS}ms.`, { cause: error });
        }
        throw error;
      }
      await delay(ENTERPRISE_GET_RETRY_DELAY_MS);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Enterprise request failed.');
};
