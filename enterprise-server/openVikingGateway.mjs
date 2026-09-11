const DEFAULT_PREFIX = '/api/enterprise/openviking';
const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:1933';
const DEFAULT_TIMEOUT_MS = 2_500;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT = 32;
const DEFAULT_CIRCUIT_FAILURES = 3;
const DEFAULT_CIRCUIT_RESET_MS = 30_000;
const DEFAULT_TASK_POLL_WINDOW_MS = 10_000;

export const openVikingDefault = () => ({
  enabled: false,
});

export const normalizeOpenViking = (input = {}, existing = {}) => {
  const source = input && typeof input === 'object' ? input : {};
  const previous = existing && typeof existing === 'object' ? existing : {};
  return {
    enabled: Object.hasOwn(source, 'enabled')
      ? source.enabled === true
      : previous.enabled === true,
  };
};

export const openVikingClientPolicy = ({ enabled, baseUrl }) => ({
  enabled: enabled === true,
  baseUrl: String(baseUrl || '').trim().replace(/\/+$/, ''),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  autoRecallTimeoutMs: DEFAULT_TIMEOUT_MS,
  autoCapture: true,
  autoRecall: true,
  recallTargetTypes: ['user'],
  peerRole: 'none',
  commitTokenThresholdRatio: 0,
  commitKeepRecentCount: 0,
  enabledTools: ['memory_recall', 'memory_store'],
  enableAddResourceTool: false,
});

export const openVikingAdminState = input => {
  const config = normalizeOpenViking(input);
  return {
    enabled: config.enabled,
    upstreamUrl: String(process.env.LFCLAW_OPENVIKING_UPSTREAM_URL || DEFAULT_UPSTREAM_URL).trim(),
    accountId: String(process.env.LFCLAW_OPENVIKING_ACCOUNT_ID || 'lfclaw').trim(),
    timeoutMs: clampInteger(process.env.LFCLAW_OPENVIKING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 500, 30_000),
    upstreamApiKeyConfigured: Boolean(String(process.env.LFCLAW_OPENVIKING_API_KEY || '').trim()),
  };
};

const safeSegment = '[A-Za-z0-9._:-]{1,200}';
const safeIdentity = new RegExp(`^${safeSegment}$`);
const allowedRoutes = [
  ['GET', /^\/health$/],
  ['GET', /^\/ready$/],
  ['GET', /^\/api\/v1\/system\/status$/],
  ['GET', /^\/api\/v1\/sessions$/],
  ['POST', /^\/api\/v1\/sessions$/],
  ['GET', new RegExp(`^/api/v1/sessions/${safeSegment}$`)],
  ['POST', new RegExp(`^/api/v1/sessions/${safeSegment}/messages$`)],
  ['POST', new RegExp(`^/api/v1/sessions/${safeSegment}/commit$`)],
  ['GET', new RegExp(`^/api/v1/sessions/${safeSegment}/context$`)],
  ['GET', new RegExp(`^/api/v1/sessions/${safeSegment}/archives/${safeSegment}$`)],
  ['GET', new RegExp(`^/api/v1/sessions/${safeSegment}/tool-results$`)],
  ['GET', new RegExp(`^/api/v1/sessions/${safeSegment}/tool-results/${safeSegment}$`)],
  ['GET', new RegExp(`^/api/v1/sessions/${safeSegment}/tool-results/${safeSegment}/search$`)],
  ['GET', new RegExp(`^/api/v1/tasks/${safeSegment}$`)],
  ['POST', /^\/api\/v1\/search\/find$/],
  ['POST', /^\/api\/v1\/search\/grep$/],
  ['GET', /^\/api\/v1\/content\/read$/],
  ['GET', /^\/api\/v1\/fs\/ls$/],
];

const sensitiveCredentialKeyPattern = /(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|token|secret|password|passwd|passcode)$/i;
const sensitivePersonalKeyPattern = /^(?:phone|mobile|contact(?:phone|mobile)(?:number)?|id[_-]?card|identity[_-]?card|bank[_-]?card)$/i;
const reservedIdentityKeyPattern = /^(?:account[_-]?id|accountId|user[_-]?id|userId|tenant[_-]?id|tenantId)$/i;

const sensitiveTextPatterns = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]'],
  [/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|cookie|secret|密码|口令)\s*[:=：]\s*)[^\s,，;；]{4,}/gi, '$1[REDACTED]'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]'],
  [/(?<!\d)\d{17}[0-9Xx](?!\d)/g, '[REDACTED_ID_CARD]'],
  [/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g, '[REDACTED_BANK_CARD]'],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]'],
];

const clampInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const normalizeBaseUrl = value => {
  const text = String(value || DEFAULT_UPSTREAM_URL).trim().replace(/\/+$/, '');
  const parsed = new URL(text);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OpenViking upstream URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OpenViking upstream URL must not contain credentials, query, or hash.');
  }
  return parsed.toString().replace(/\/+$/, '');
};

const writeJsonError = (res, status, code, message, extraHeaders = {}) => {
  const body = JSON.stringify({
    status: 'error',
    error: { code, message },
  });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
};

const requestToken = req => {
  const apiKey = req.headers?.['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
  const authorization = req.headers?.authorization;
  return typeof authorization === 'string'
    ? authorization.replace(/^Bearer\s+/i, '').trim()
    : '';
};

const readBody = async (req, maxBodyBytes) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      const error = new Error('OpenViking request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
};

const sanitizeText = value => sensitiveTextPatterns.reduce(
  (text, [pattern, replacement]) => text.replace(pattern, replacement),
  String(value),
);

export const sanitizeOpenVikingPayload = value => {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeOpenVikingPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    sensitiveCredentialKeyPattern.test(key) || sensitivePersonalKeyPattern.test(key)
      ? '[REDACTED]'
      : sanitizeOpenVikingPayload(child),
  ]));
};

const containsReservedIdentityField = value => {
  if (Array.isArray(value)) return value.some(containsReservedIdentityField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    reservedIdentityKeyPattern.test(key) || containsReservedIdentityField(child)
  ));
};

const isUserMemoryUri = (value, userId) => {
  const uri = String(value || '').trim().replace(/\/+$/, '');
  if (!uri) return false;
  const genericRoot = 'viking://user/memories';
  const expandedRoot = `viking://user/${userId}/memories`;
  return uri === genericRoot
    || uri.startsWith(`${genericRoot}/`)
    || uri === expandedRoot
    || uri.startsWith(`${expandedRoot}/`);
};

const validateUserScope = ({ upstreamPath, searchParams, payload, userId }) => {
  if (containsReservedIdentityField(payload)) {
    return {
      status: 403,
      code: 'identity_override_not_allowed',
      message: 'OpenViking account and user identity are managed by LFCLAW.',
    };
  }

  if (upstreamPath === '/api/v1/search/find' || upstreamPath === '/api/v1/search/grep') {
    const targetUri = payload?.target_uri ?? payload?.targetUri ?? payload?.uri;
    if (!isUserMemoryUri(targetUri, userId)) {
      return {
        status: 403,
        code: 'memory_scope_not_allowed',
        message: 'Only the current employee personal memory scope is available.',
      };
    }
  }

  if (upstreamPath === '/api/v1/content/read' || upstreamPath === '/api/v1/fs/ls') {
    if (!isUserMemoryUri(searchParams.get('uri'), userId)) {
      return {
        status: 403,
        code: 'memory_scope_not_allowed',
        message: 'Only the current employee personal memory scope is available.',
      };
    }
  }

  return null;
};

export const isAllowedOpenVikingRoute = (method, pathname) => {
  const normalizedMethod = String(method || '').toUpperCase();
  if (pathname.includes('%2f') || pathname.includes('%2F') || pathname.includes('..')) return false;
  return allowedRoutes.some(([allowedMethod, pattern]) => (
    allowedMethod === normalizedMethod && pattern.test(pathname)
  ));
};

export const createOpenVikingGateway = ({
  prefix = DEFAULT_PREFIX,
  upstreamUrl = process.env.LFCLAW_OPENVIKING_UPSTREAM_URL || DEFAULT_UPSTREAM_URL,
  upstreamApiKey = process.env.LFCLAW_OPENVIKING_API_KEY || '',
  accountId = process.env.LFCLAW_OPENVIKING_ACCOUNT_ID || 'lfclaw',
  timeoutMs = process.env.LFCLAW_OPENVIKING_TIMEOUT_MS,
  maxBodyBytes = process.env.LFCLAW_OPENVIKING_MAX_BODY_BYTES,
  maxConcurrent = process.env.LFCLAW_OPENVIKING_MAX_CONCURRENT,
  circuitFailures = process.env.LFCLAW_OPENVIKING_CIRCUIT_FAILURES,
  circuitResetMs = process.env.LFCLAW_OPENVIKING_CIRCUIT_RESET_MS,
  taskPollWindowMs = process.env.LFCLAW_OPENVIKING_TASK_POLL_WINDOW_MS,
  isEnabled,
  authenticate,
  fetchImpl = fetch,
  now = Date.now,
  logger = console,
} = {}) => {
  if (typeof isEnabled !== 'function') throw new Error('OpenViking gateway requires isEnabled().');
  if (typeof authenticate !== 'function') throw new Error('OpenViking gateway requires authenticate().');

  const normalizedPrefix = `/${String(prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '')}`;
  const normalizedUpstreamUrl = normalizeBaseUrl(upstreamUrl);
  const normalizedAccountId = String(accountId || 'lfclaw').trim();
  if (!safeIdentity.test(normalizedAccountId)) {
    throw new Error('OpenViking account ID contains unsupported characters.');
  }
  const requestTimeoutMs = clampInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 500, 30_000);
  const requestBodyLimit = clampInteger(maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 16 * 1024, 16 * 1024 * 1024);
  const concurrencyLimit = clampInteger(maxConcurrent, DEFAULT_MAX_CONCURRENT, 1, 512);
  const failureThreshold = clampInteger(circuitFailures, DEFAULT_CIRCUIT_FAILURES, 1, 20);
  const resetAfterMs = clampInteger(circuitResetMs, DEFAULT_CIRCUIT_RESET_MS, 1_000, 5 * 60_000);
  const taskWindowMs = clampInteger(taskPollWindowMs, DEFAULT_TASK_POLL_WINDOW_MS, 2_500, 60_000);

  let activeRequests = 0;
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  const taskFirstSeenAt = new Map();

  return async (req, res, url) => {
    const pathname = url?.pathname || '/';
    if (pathname !== normalizedPrefix && !pathname.startsWith(`${normalizedPrefix}/`)) return false;

    const upstreamPath = pathname.slice(normalizedPrefix.length) || '/';
    if (!isAllowedOpenVikingRoute(req.method, upstreamPath)) {
      writeJsonError(res, 403, 'route_not_allowed', 'This OpenViking operation is not enabled by LFCLAW.');
      return true;
    }
    let identity;
    try {
      identity = authenticate(requestToken(req));
    } catch (error) {
      logger.warn('[OpenVikingGateway] enterprise authentication failed:', error);
      writeJsonError(res, 503, 'enterprise_auth_unavailable', 'Enterprise authentication is temporarily unavailable.');
      return true;
    }
    if (!identity) {
      writeJsonError(res, 401, 'invalid_enterprise_session', 'Enterprise session is invalid.');
      return true;
    }
    if (identity.status && identity.status !== 'active') {
      writeJsonError(res, 403, 'employee_disabled', 'Enterprise employee is disabled.');
      return true;
    }
    const userId = String(identity.userId || '').trim();
    if (!safeIdentity.test(userId)) {
      writeJsonError(res, 503, 'memory_identity_missing', 'OpenViking user identity is not configured.');
      return true;
    }
    try {
      if (!isEnabled()) {
        writeJsonError(res, 503, 'memory_disabled', 'OpenViking memory is disabled by the enterprise administrator.');
        return true;
      }
    } catch (error) {
      logger.warn('[OpenVikingGateway] memory switch lookup failed:', error);
      writeJsonError(res, 503, 'memory_config_unavailable', 'OpenViking configuration is temporarily unavailable.');
      return true;
    }

    const currentTime = now();
    const taskId = upstreamPath.match(/^\/api\/v1\/tasks\/([A-Za-z0-9._:-]{1,200})$/)?.[1];
    if (taskId) {
      for (const [knownTaskKey, firstSeenAt] of taskFirstSeenAt) {
        if (currentTime - firstSeenAt > taskWindowMs * 2) taskFirstSeenAt.delete(knownTaskKey);
      }
      const taskKey = `${userId}\0${taskId}`;
      const firstSeenAt = taskFirstSeenAt.get(taskKey) ?? currentTime;
      taskFirstSeenAt.set(taskKey, firstSeenAt);
      if (currentTime - firstSeenAt >= taskWindowMs) {
        taskFirstSeenAt.delete(taskKey);
        writeJsonError(
          res,
          504,
          'memory_task_timeout',
          'OpenViking memory extraction is taking too long. Chat can continue without waiting.',
        );
        return true;
      }
    }
    if (circuitOpenUntil > currentTime) {
      writeJsonError(
        res,
        503,
        'memory_temporarily_unavailable',
        'OpenViking is temporarily unavailable. Chat can continue without memory.',
        { 'retry-after': String(Math.max(1, Math.ceil((circuitOpenUntil - currentTime) / 1000))) },
      );
      return true;
    }
    if (activeRequests >= concurrencyLimit) {
      writeJsonError(res, 429, 'memory_busy', 'OpenViking is busy. Chat can continue without memory.', { 'retry-after': '1' });
      return true;
    }

    activeRequests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const abortOnClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', abortOnClose);

    try {
      const rawBody = req.method === 'GET' || req.method === 'HEAD'
        ? Buffer.alloc(0)
        : await readBody(req, requestBodyLimit);
      let body;
      let parsedBody;
      if (rawBody.length > 0) {
        const contentType = String(req.headers?.['content-type'] || '');
        if (!contentType.toLowerCase().includes('application/json')) {
          writeJsonError(res, 415, 'unsupported_media_type', 'Only JSON OpenViking requests are allowed.');
          return true;
        }
        try {
          parsedBody = JSON.parse(rawBody.toString('utf8'));
        } catch {
          writeJsonError(res, 400, 'invalid_json', 'OpenViking request body must be valid JSON.');
          return true;
        }
        const scopeError = validateUserScope({
          upstreamPath,
          searchParams: url.searchParams,
          payload: parsedBody,
          userId,
        });
        if (scopeError) {
          writeJsonError(res, scopeError.status, scopeError.code, scopeError.message);
          return true;
        }
        body = JSON.stringify(sanitizeOpenVikingPayload(parsedBody));
      } else {
        const scopeError = validateUserScope({
          upstreamPath,
          searchParams: url.searchParams,
          payload: undefined,
          userId,
        });
        if (scopeError) {
          writeJsonError(res, scopeError.status, scopeError.code, scopeError.message);
          return true;
        }
      }

      const upstreamRequestUrl = new URL(`${normalizedUpstreamUrl}${upstreamPath}`);
      for (const [key, value] of url.searchParams) upstreamRequestUrl.searchParams.append(key, value);
      const headers = {
        accept: String(req.headers?.accept || 'application/json'),
        'x-openviking-account': normalizedAccountId,
        'x-openviking-user': userId,
        'user-agent': 'lfclaw-enterprise-openviking-gateway/1',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(upstreamApiKey ? { 'x-api-key': String(upstreamApiKey) } : {}),
      };

      const upstream = await fetchImpl(upstreamRequestUrl, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      });

      if (upstream.status >= 500) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= failureThreshold) circuitOpenUntil = now() + resetAfterMs;
      } else {
        consecutiveFailures = 0;
        circuitOpenUntil = 0;
      }

      const responseHeaders = {
        'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      };
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter) responseHeaders['retry-after'] = retryAfter;
      res.writeHead(upstream.status, responseHeaders);
      if (!upstream.body) {
        res.end();
        return true;
      }
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
      return true;
    } catch (error) {
      if (error?.status === 413) {
        writeJsonError(res, 413, 'request_too_large', error.message);
        return true;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= failureThreshold) circuitOpenUntil = now() + resetAfterMs;
      const timedOut = controller.signal.aborted;
      logger.warn('[OpenVikingGateway] upstream request failed:', error);
      if (!res.headersSent) {
        writeJsonError(
          res,
          timedOut ? 504 : 503,
          timedOut ? 'memory_timeout' : 'memory_unavailable',
          timedOut
            ? `OpenViking did not respond within ${requestTimeoutMs}ms. Chat can continue without memory.`
            : 'OpenViking is unavailable. Chat can continue without memory.',
        );
      } else if (!res.writableEnded) {
        res.end();
      }
      return true;
    } finally {
      clearTimeout(timer);
      res.removeListener('close', abortOnClose);
      activeRequests -= 1;
    }
  };
};
