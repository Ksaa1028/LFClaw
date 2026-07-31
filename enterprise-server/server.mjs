import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.LFCLAW_ENTERPRISE_HOST || '127.0.0.1';
const PORT = Number(process.env.LFCLAW_ENTERPRISE_PORT || 8787);
const ADMIN_TOKEN = process.env.LFCLAW_ADMIN_TOKEN || 'lfclaw-admin';
const ROOT_DIR = process.platform === 'win32' ? __dirname : '/opt/LfClaw';
const DATA_DIR = process.env.LFCLAW_ENTERPRISE_DATA_DIR || path.join(ROOT_DIR, 'data');
const DATA_FILE = process.env.LFCLAW_ENTERPRISE_DATA || path.join(DATA_DIR, 'enterprise-data.json');
const STORAGE_DIR = process.env.LFCLAW_ENTERPRISE_STORAGE || path.join(ROOT_DIR, 'storage');
const SKILL_DIR = path.join(STORAGE_DIR, 'skills');
const BACKUP_DIR = process.env.LFCLAW_ENTERPRISE_BACKUP_DIR || path.join(DATA_DIR, 'backups');
const RELEASE_DIR = process.env.LFCLAW_ENTERPRISE_RELEASE_DIR || path.join(ROOT_DIR, 'releases');
const ENTERPRISE_SKILL_VERSION_GUARD_ENABLED = process.env.LFCLAW_ENTERPRISE_SKILL_VERSION_GUARD === '1';
const MIN_ENTERPRISE_SKILL_CLIENT_VERSION = String(process.env.LFCLAW_MIN_ENTERPRISE_SKILL_CLIENT_VERSION || '').trim();
const asrProxySessions = new Map();
const ASR_PROXY_SESSION_TTL_MS = 2 * 60 * 1000;
const ASR_INFERENCE_PATH = '/api-ws/v1/inference';
const MODEL_CONNECTION_TEST_TOKEN_BUDGET = 16;

const nowIso = () => new Date().toISOString();
const id = prefix => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const randomHex = len => crypto.randomBytes(len).toString('hex');
const toNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const list = value => Array.isArray(value) ? [...new Set(value.map(v => String(v).trim()).filter(Boolean))] : [];
const normalizeClientVersion = value => String(value || '').trim().replace(/^v/i, '');
const versionDigits = value => normalizeClientVersion(value).replace(/\D/g, '');
const compareClientVersion = (left, right) => {
  const a = versionDigits(left);
  const b = versionDigits(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const width = Math.max(a.length, b.length);
  return a.padEnd(width, '0').localeCompare(b.padEnd(width, '0'));
};
const canDeliverEnterpriseSkills = clientVersion => (
  !ENTERPRISE_SKILL_VERSION_GUARD_ENABLED
  || !MIN_ENTERPRISE_SKILL_CLIENT_VERSION
  || compareClientVersion(clientVersion, MIN_ENTERPRISE_SKILL_CLIENT_VERSION) >= 0
);
const clientVersionFromRequest = (req, url, body = {}) => (
  normalizeClientVersion(body.clientVersion)
  || normalizeClientVersion(url?.searchParams?.get('clientVersion'))
  || normalizeClientVersion(req.headers['x-lfclaw-client-version'])
);
const json = (res, status, payload) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization,x-admin-token,x-lfclaw-client-version',
    'access-control-allow-methods': 'GET,HEAD,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(JSON.stringify(payload));
};
const ok = (res, data = {}) => json(res, 200, { code: 0, data });
const fail = (res, status, message) => json(res, status, { code: status, message });
const isOutputLimitConnectivitySuccess = (status, responseText) => {
  if (status !== 400) return false;

  let error;
  try {
    error = JSON.parse(responseText)?.error;
  } catch {
    return false;
  }

  if (error?.type !== 'invalid_request_error') return false;

  const message = String(error.message || '').toLowerCase();
  return (
    message.includes('model output limit was reached')
    || (message.includes('could not finish the message') && message.includes('max_tokens'))
  );
};

const asrDefault = () => ({
  provider: 'aliyun-dashscope',
  name: '阿里云实时语音识别',
  workspaceId: '',
  region: 'cn-beijing',
  apiHost: '',
  websocketUrl: '',
  apiKey: '',
  model: 'fun-asr-realtime',
  format: 'wav',
  sampleRate: 16000,
  chunkIntervalMillis: 200,
  maxSessionSeconds: 60,
  priceNote: '',
});

const normalizeAsr = (input = {}, existing = {}) => {
  const source = input && typeof input === 'object' ? input : {};
  const previous = existing && typeof existing === 'object' ? existing : {};
  const next = { ...asrDefault(), ...previous };
  const apiKeyText = String(source.apiKey ?? '').trim();
  return {
    ...next,
    provider: 'aliyun-dashscope',
    name: String(source.name ?? next.name ?? '').trim() || asrDefault().name,
    workspaceId: String(source.workspaceId ?? next.workspaceId ?? '').trim(),
    region: String(source.region ?? next.region ?? 'cn-beijing').trim() || 'cn-beijing',
    apiHost: String(source.apiHost ?? next.apiHost ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
    websocketUrl: String(source.websocketUrl ?? next.websocketUrl ?? '').trim(),
    apiKey: apiKeyText && !/^\*+$/.test(apiKeyText) ? apiKeyText : String(next.apiKey || ''),
    model: String(source.model ?? next.model ?? 'fun-asr-realtime').trim() || 'fun-asr-realtime',
    format: 'pcm',
    sampleRate: toNumber(source.sampleRate ?? next.sampleRate, 16000),
    chunkIntervalMillis: toNumber(source.chunkIntervalMillis ?? next.chunkIntervalMillis, 200),
    maxSessionSeconds: toNumber(source.maxSessionSeconds ?? next.maxSessionSeconds, 60),
    priceNote: String(source.priceNote ?? next.priceNote ?? '').trim(),
  };
};

const resolveAsrWsUrl = asr => {
  const config = normalizeAsr(asr);
  if (config.websocketUrl) return config.websocketUrl.replace(/\/+$/, '');
  if (config.workspaceId) return `wss://${config.workspaceId}.${config.region || 'cn-beijing'}.maas.aliyuncs.com${ASR_INFERENCE_PATH}`;
  if (config.apiHost) return `wss://${config.apiHost}${ASR_INFERENCE_PATH}`;
  return '';
};

const publicAsr = asr => {
  const config = normalizeAsr(asr);
  return {
    provider: config.provider,
    name: config.name,
    workspaceId: config.workspaceId,
    region: config.region,
    apiHost: config.apiHost,
    websocketUrl: config.websocketUrl,
    model: config.model,
    format: config.format,
    sampleRate: config.sampleRate,
    chunkIntervalMillis: config.chunkIntervalMillis,
    maxSessionSeconds: config.maxSessionSeconds,
    configured: Boolean(config.apiKey && resolveAsrWsUrl(config)),
  };
};

const redactAsr = asr => {
  const config = normalizeAsr(asr);
  return {
    ...config,
    apiKey: config.apiKey ? '********' : '',
    configured: Boolean(config.apiKey && resolveAsrWsUrl(config)),
  };
};

const closeWebSocket = socket => {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
};

const sendAsrEvent = (socket, payload) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
};

const sendAsrError = (socket, requestId, code, message) => {
  sendAsrEvent(socket, { type: 'error', requestId, code, message });
};

const releaseMimeType = filePath => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.dmg') return 'application/x-apple-diskimage';
  if (ext === '.exe') return 'application/vnd.microsoft.portable-executable';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.yml' || ext === '.yaml') return 'text/yaml; charset=utf-8';
  return 'application/octet-stream';
};

const releaseFileHash = filePath => {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

const parseRangeHeader = (rangeHeader, size) => {
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const startText = match[1];
  const endText = match[2];
  let start = startText ? Number(startText) : 0;
  let end = endText ? Number(endText) : size - 1;
  if (!startText && endText) {
    const suffixLength = Number(endText);
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
};

const serveReleaseFile = (req, res, pathname) => {
  if (!pathname.startsWith('/releases/')) return false;
  const filename = decodeURIComponent(pathname.slice('/releases/'.length));
  if (!filename || filename !== path.basename(filename) || !/^[A-Za-z0-9._-]+$/.test(filename)) {
    fail(res, 400, 'Invalid release filename.');
    return true;
  }
  const filePath = path.join(RELEASE_DIR, filename);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(res, 404, 'Release file not found.');
    return true;
  }
  const stat = fs.statSync(filePath);
  const baseHeaders = {
    'content-type': releaseMimeType(filePath),
    'content-disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
  };
  const range = parseRangeHeader(req.headers.range, stat.size);
  if (req.headers.range && !range) {
    res.writeHead(416, {
      ...baseHeaders,
      'content-range': `bytes */${stat.size}`,
      'content-length': 0,
    });
    res.end();
    return true;
  }
  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...baseHeaders,
      'content-length': length,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(filePath, range).pipe(res);
    return true;
  }
  res.writeHead(200, {
    ...baseHeaders,
    'content-length': stat.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
};

const readLinesFile = filePath => {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

const releaseFileUrl = (origin, filename) => `${origin.replace(/\/+$/, '')}/releases/${encodeURIComponent(filename)}`;

const detectReleasePlatform = filename => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.exe')) return 'windowsX64Url';
  if (!lower.endsWith('.dmg')) return '';
  if (/(arm64|aarch64|apple|silicon)/.test(lower)) return 'macArmUrl';
  if (/(x64|x86_64|intel)/.test(lower)) return 'macIntelUrl';
  return 'macUniversalUrl';
};

const detectAutoRelease = origin => {
  if (!fs.existsSync(RELEASE_DIR)) return null;
  const candidates = fs.readdirSync(RELEASE_DIR)
    .filter(name => /^[A-Za-z0-9._-]+$/.test(name))
    .map(name => {
      const version = name.match(/20\d{8}/)?.[0] || '';
      const platform = detectReleasePlatform(name);
      if (!version || !platform) return null;
      const filePath = path.join(RELEASE_DIR, name);
      const stat = fs.statSync(filePath);
      return { name, version, platform, mtimeMs: stat.mtimeMs, size: stat.size, sha256: releaseFileHash(filePath) };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.version) - Number(a.version) || b.mtimeMs - a.mtimeMs);
  const latestVersion = candidates[0]?.version || '';
  if (!latestVersion) return null;
  const latest = candidates.filter(item => item.version === latestVersion);
  const result = {
    version: latestVersion,
    date: `${latestVersion.slice(0, 4)}-${latestVersion.slice(4, 6)}-${latestVersion.slice(6, 8)}`,
    notesZh: readLinesFile(path.join(RELEASE_DIR, `changelog-${latestVersion}.zh.txt`)),
    notesEn: readLinesFile(path.join(RELEASE_DIR, `changelog-${latestVersion}.en.txt`)),
    windowsX64Url: '',
    windowsX64Size: undefined,
    windowsX64Sha256: '',
    macArmUrl: '',
    macArmSize: undefined,
    macArmSha256: '',
    macIntelUrl: '',
    macIntelSize: undefined,
    macIntelSha256: '',
  };
  if (result.notesZh.length === 0) result.notesZh = readLinesFile(path.join(RELEASE_DIR, 'changelog.zh.txt'));
  if (result.notesZh.length === 0) result.notesZh = readLinesFile(path.join(RELEASE_DIR, 'changelog.txt'));
  if (result.notesEn.length === 0) result.notesEn = readLinesFile(path.join(RELEASE_DIR, 'changelog.en.txt'));
  if (result.notesEn.length === 0) result.notesEn = result.notesZh;
  for (const item of latest) {
    const url = releaseFileUrl(origin, item.name);
    if (item.platform === 'macUniversalUrl') {
      result.macArmUrl ||= url;
      result.macArmSize ||= item.size;
      result.macArmSha256 ||= item.sha256;
      result.macIntelUrl ||= url;
      result.macIntelSize ||= item.size;
      result.macIntelSha256 ||= item.sha256;
    } else {
      result[item.platform] ||= url;
      const prefix = item.platform.replace(/Url$/, '');
      result[`${prefix}Size`] ||= item.size;
      result[`${prefix}Sha256`] ||= item.sha256;
    }
  }
  return result;
};

const defaultData = () => ({
  enterpriseName: 'LfClaw Enterprise',
  asr: asrDefault(),
  modelProviders: [],
  mcpServers: [],
  skills: [],
  employees: [],
  sessions: {},
  usageEvents: [],
  release: {
    version: '',
    date: '',
    notesZh: '',
    notesEn: '',
    windowsX64Url: '',
    macArmUrl: '',
    macIntelUrl: '',
    manualUrl: '',
  },
});

const ensureData = data => ({
  ...defaultData(),
  ...data,
  modelProviders: Array.isArray(data.modelProviders) ? data.modelProviders : Array.isArray(data.models) ? data.models : [],
  mcpServers: Array.isArray(data.mcpServers) ? data.mcpServers : [],
  skills: Array.isArray(data.skills) ? data.skills : [],
  employees: Array.isArray(data.employees) ? data.employees : Array.isArray(data.activations) ? data.activations : [],
  sessions: data.sessions && typeof data.sessions === 'object' ? data.sessions : {},
  usageEvents: Array.isArray(data.usageEvents) ? data.usageEvents : [],
  asr: normalizeAsr(data.asr || {}, defaultData().asr),
  release: data.release && typeof data.release === 'object' ? { ...defaultData().release, ...data.release } : defaultData().release,
});

const readData = () => {
  try {
    if (!fs.existsSync(DATA_FILE)) return defaultData();
    return ensureData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return defaultData();
  }
};

const writeData = data => {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(ensureData(data), null, 2), 'utf8');
};

const backupTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const backupFileName = () => `enterprise-data-${backupTimestamp()}.json`;
const assertBackupName = name => /^enterprise-data-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(name);

const listBackups = () => {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(assertBackupName)
    .map(name => {
      const fullPath = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(fullPath);
      return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
};

const createBackup = data => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = backupFileName();
  const fullPath = path.join(BACKUP_DIR, name);
  fs.writeFileSync(fullPath, JSON.stringify(ensureData(data), null, 2), 'utf8');
  const stat = fs.statSync(fullPath);
  return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
};

const readBody = async req => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
};

const readRawBody = async req => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const parseJson = value => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
};

const parseMultipart = (buffer, contentType) => {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) throw new Error('缺少上传边界。');
  const raw = buffer.toString('binary');
  const parts = raw.split(`--${boundary}`).slice(1, -1);
  const fields = {};
  const files = {};
  for (const part of parts) {
    const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = trimmed.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const header = trimmed.slice(0, sep);
    const body = Buffer.from(trimmed.slice(sep + 4), 'binary');
    const name = header.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const filename = header.match(/filename="([^"]*)"/)?.[1];
    if (filename) files[name] = { filename: path.basename(filename), content: body };
    else fields[name] = body.toString('utf8');
  }
  return { fields, files };
};

const PINYIN_MAP = {
  张: 'zhang',
  三: 'san',
  李: 'li',
  四: 'si',
  王: 'wang',
  赵: 'zhao',
  刘: 'liu',
  陈: 'chen',
  杨: 'yang',
  黄: 'huang',
  周: 'zhou',
  吴: 'wu',
  徐: 'xu',
  孙: 'sun',
  胡: 'hu',
  朱: 'zhu',
  高: 'gao',
  林: 'lin',
  何: 'he',
  郭: 'guo',
  马: 'ma',
  罗: 'luo',
  梁: 'liang',
  宋: 'song',
  郑: 'zheng',
  谢: 'xie',
  韩: 'han',
  唐: 'tang',
  佟: 'tong',
  凯: 'kai',
  俊: 'jun',
  峰: 'feng',
};

const pinyinSlug = name => {
  const parts = [];
  for (const char of String(name || '').trim()) {
    if (/[a-z0-9]/i.test(char)) parts.push(char.toLowerCase());
    else if (PINYIN_MAP[char]) parts.push(PINYIN_MAP[char]);
  }
  return parts.join('') || `user${randomHex(2)}`;
};

const makeEmployeeId = name => `u_${pinyinSlug(name)}_${randomHex(2)}`;
const makeActivationCode = name => `LFCLAW-${pinyinSlug(name).toUpperCase()}-${randomHex(3).toUpperCase()}`;

const normalizeModel = (body, existing = {}) => {
  const modelId = String(body.modelId || body.id || existing.id || '').trim();
  const rawApiKey = body.apiKey === undefined ? undefined : String(body.apiKey || '').trim();
  const apiKey = rawApiKey && !/^\*+$/.test(rawApiKey) ? rawApiKey : String(existing.apiKey || '').trim();
  const billing = {
    ...(existing.billing || {}),
    currency: String(body.currency || existing.billing?.currency || 'USD'),
    inputPricePerMillionTokens: toNumber(body.inputPricePerMillionTokens, toNumber(existing.billing?.inputPricePerMillionTokens)),
    outputPricePerMillionTokens: toNumber(body.outputPricePerMillionTokens, toNumber(existing.billing?.outputPricePerMillionTokens)),
    cacheWritePricePerMillionTokens: toNumber(body.cacheWritePricePerMillionTokens, toNumber(existing.billing?.cacheWritePricePerMillionTokens)),
    cacheReadPricePerMillionTokens: toNumber(body.cacheReadPricePerMillionTokens, toNumber(existing.billing?.cacheReadPricePerMillionTokens)),
    creditsPerCurrencyUnit: toNumber(body.creditsPerCurrencyUnit, toNumber(existing.billing?.creditsPerCurrencyUnit, 10)),
    fixedCreditsPerCall: toNumber(body.fixedCreditsPerCall, toNumber(existing.billing?.fixedCreditsPerCall)),
    minimumCreditsPerCall: toNumber(body.minimumCreditsPerCall, toNumber(existing.billing?.minimumCreditsPerCall, 1)),
    imagePriceNote: String(body.imagePriceNote || existing.billing?.imagePriceNote || ''),
    audioPriceNote: String(body.audioPriceNote || existing.billing?.audioPriceNote || ''),
    videoPriceNote: String(body.videoPriceNote || existing.billing?.videoPriceNote || ''),
    sourceUrl: String(body.priceSourceUrl || existing.billing?.sourceUrl || ''),
  };
  const modelTypes = list(body.modelTypes ?? existing.models?.[0]?.modelTypes ?? existing.modelTypes);
  const contextWindow = toNumber(body.contextWindow, toNumber(existing.models?.[0]?.contextWindow, toNumber(existing.contextWindow)));
  const modelTypeSupportsImage = modelTypes.includes('multimodal-understanding') || modelTypes.includes('ocr-document');
  const supportsImage = body.supportsImage !== undefined
    ? body.supportsImage === true || body.supportsImage === 'true' || body.supportsImage === 'on'
    : body.modelTypes !== undefined
      ? modelTypeSupportsImage
      : existing.supportsImage === true || existing.models?.[0]?.supportsImage === true;
  const item = {
    ...existing,
    id: modelId,
    name: String(body.modelName || body.name || existing.name || modelId).trim(),
    provider: 'custom',
    apiFormat: ['openai', 'anthropic', 'gemini'].includes(body.apiFormat) ? body.apiFormat : existing.apiFormat || 'openai',
    baseUrl: String(body.baseUrl || existing.baseUrl || '').trim(),
    apiKey,
    supportsImage,
    modelTypes,
    ...(contextWindow > 0 ? { contextWindow } : {}),
    models: [{ id: modelId, name: String(body.modelName || body.name || modelId).trim(), supportsImage, modelTypes, ...(contextWindow > 0 ? { contextWindow } : {}) }],
    billing,
    enabled: body.enabled !== undefined ? body.enabled !== false : existing.enabled !== false,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  if (!item.id) throw new Error('模型 ID 必填。');
  if (!item.baseUrl) throw new Error('模型必须配置 Base URL。');
  if (!item.apiKey) throw new Error('模型必须配置 API Key。');
  return item;
};

const normalizeMcp = (body, existing = {}) => {
  const transportType = ['stdio', 'sse', 'http', 'streamable-http'].includes(body.transportType) ? body.transportType : existing.transportType || 'sse';
  const item = {
    ...existing,
    id: String(body.id || existing.id || '').trim(),
    name: String(body.name || existing.name || body.id || '').trim(),
    description: String(body.description ?? existing.description ?? ''),
    transportType,
    url: String(body.url || existing.url || '').trim(),
    headers: parseJson(body.headers ?? existing.headers),
    command: String(body.command || existing.command || '').trim(),
    args: list(body.args ?? existing.args),
    env: parseJson(body.env ?? existing.env),
    enabled: body.enabled !== undefined ? body.enabled !== false : existing.enabled !== false,
    createdAt: existing.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
  if (!item.id) throw new Error('MCP ID 必填。');
  if (item.transportType === 'stdio' && !item.command) throw new Error('stdio MCP 必须配置命令。');
  if (item.transportType !== 'stdio' && !item.url) throw new Error('远程 MCP 必须配置 URL。');
  return item;
};

const normalizeSkill = (body, existing = {}) => ({
  ...existing,
  id: String(body.id || existing.id || '').trim(),
  name: String(body.name || existing.name || body.id || '').trim(),
  description: String(body.description ?? existing.description ?? ''),
  version: String(body.version ?? existing.version ?? '1.0.0'),
  packageFileName: String(body.packageFileName ?? existing.packageFileName ?? ''),
  packagePath: String(body.packagePath ?? existing.packagePath ?? ''),
  packageSha256: String(body.packageSha256 ?? existing.packageSha256 ?? ''),
  packageSize: toNumber(body.packageSize, toNumber(existing.packageSize)),
  enabled: body.enabled !== undefined ? body.enabled !== false : existing.enabled !== false,
  createdAt: existing.createdAt || nowIso(),
  updatedAt: nowIso(),
});

const employeeView = employee => ({
  ...employee,
  clientVersion: normalizeClientVersion(employee.clientVersion || employee.appVersion),
  lastActivatedClientVersion: normalizeClientVersion(employee.lastActivatedClientVersion),
  lastSeenClientVersion: normalizeClientVersion(employee.lastSeenClientVersion || employee.clientVersion || employee.appVersion),
  creditsLimit: toNumber(employee.creditsLimit),
  creditsUsed: toNumber(employee.creditsUsed),
  allowedModelProviderIds: list(employee.allowedModelProviderIds ?? employee.allowedModelIds),
  allowedMcpServerIds: list(employee.allowedMcpServerIds),
  allowedSkillIds: list(employee.allowedSkillIds),
});

const redactModel = provider => ({ ...provider, apiKey: provider.apiKey ? '********' : '' });
const adminState = data => ({
  enterpriseName: data.enterpriseName,
  modelProviders: data.modelProviders.map(redactModel),
  models: data.modelProviders.map(redactModel),
  asr: redactAsr(data.asr),
  mcpServers: data.mcpServers,
  skills: data.skills.map(skill => ({ ...skill, packagePath: undefined })),
  employees: data.employees.map(employeeView),
  usageEvents: data.usageEvents.slice(-300),
  release: data.release,
  backups: listBackups(),
});

const requestOrigin = req => `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`}`;
const selectByIds = (items, ids) => {
  const allowed = new Set(list(ids));
  if (allowed.size === 0) return [];
  return items.filter(item => item.enabled !== false && allowed.has(item.id));
};

const clientPayload = (data, employee, accessToken, req, clientVersion = '') => {
  const effectiveClientVersion = normalizeClientVersion(clientVersion || employee.clientVersion || employee.appVersion);
  const modelProviders = selectByIds(data.modelProviders, employee.allowedModelProviderIds ?? employee.allowedModelIds);
  const mcpServers = selectByIds(data.mcpServers, employee.allowedMcpServerIds);
  const skillPayload = skill => ({
    ...skill,
    packagePath: undefined,
    downloadUrl: skill.packageFileName ? `${requestOrigin(req)}/api/enterprise/skills/${encodeURIComponent(skill.id)}/download` : '',
  });
  const authorizedSkills = selectByIds(data.skills, employee.allowedSkillIds).map(skillPayload);
  const enterpriseSkills = authorizedSkills;
  const skills = authorizedSkills;
  return {
    accessToken,
    user: { userId: employee.employeeId, yid: employee.employeeId, nickname: employee.employeeName, avatarUrl: null, status: 1 },
    quota: {
      planName: 'LfClaw Enterprise',
      subscriptionStatus: 'active',
      creditsLimit: toNumber(employee.creditsLimit),
      creditsUsed: toNumber(employee.creditsUsed),
      creditsRemaining: Math.max(0, toNumber(employee.creditsLimit) - toNumber(employee.creditsUsed)),
      hasPaidCredits: true,
    },
    policy: {
      enterpriseName: data.enterpriseName || 'LfClaw Enterprise',
      allowedModelIds: modelProviders.flatMap(provider => provider.models.map(model => model.id)),
      allowedModelProviderIds: modelProviders.map(provider => provider.id),
      allowedMcpServerIds: mcpServers.map(server => server.id),
      allowedSkillIds: skills.map(skill => skill.id),
      modelProviders,
      mcpServers,
      skills,
      enterpriseSkills,
      skillsCatalog: enterpriseSkills,
      skillDelivery: {
        enabled: true,
        clientVersion: effectiveClientVersion,
        minimumClientVersion: '',
        guarded: false,
        reason: '',
      },
      asr: publicAsr(data.asr),
      adminUrl: `${requestOrigin(req)}/admin`,
    },
  };
};

const calculateUsageCredits = (provider, body) => {
  const billing = provider?.billing || {};
  const creditsPerCurrencyUnit = toNumber(billing.creditsPerCurrencyUnit, 100);
  const total = (
    toNumber(body.inputTokens) * toNumber(billing.inputPricePerMillionTokens)
    + toNumber(body.outputTokens) * toNumber(billing.outputPricePerMillionTokens)
    + toNumber(body.cacheWriteTokens) * toNumber(billing.cacheWritePricePerMillionTokens)
    + toNumber(body.cacheReadTokens) * toNumber(billing.cacheReadPricePerMillionTokens)
  ) / 1_000_000 * creditsPerCurrencyUnit + toNumber(billing.fixedCreditsPerCall);
  return Math.max(toNumber(billing.minimumCreditsPerCall), Number(total.toFixed(4)));
};

const adminHtml = () => String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LfClaw 企业管理</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",Arial,sans-serif;color:#0b1833;background:#f4f7fb}body{margin:0}main{max-width:1320px;margin:0 auto;padding:28px}header{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:16px}h1{margin:0;font-size:28px}.hint{color:#66758a;margin:6px 0 0}.token{display:flex;gap:8px;align-items:end}.token input{width:260px}nav{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}button{border:0;border-radius:6px;padding:9px 13px;font-weight:750;cursor:pointer;background:#0b1833;color:white}button.secondary,nav button{background:#e9eef5;color:#0b1833}button.danger{background:#df2626}.active-tab{background:#0b1833!important;color:#fff!important}section{display:none;background:#fff;border:1px solid #dce3ec;border-radius:8px;padding:18px;box-shadow:0 10px 30px rgba(15,23,42,.04)}section.active{display:block}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.grid-3{grid-template-columns:repeat(3,1fr)}.grid-5{grid-template-columns:repeat(5,1fr)}label{font-size:13px;font-weight:650;color:#24324a}input,textarea,select{width:100%;box-sizing:border-box;border:1px solid #c8d2df;border-radius:6px;padding:9px 10px;font:inherit;background:#fff}textarea{min-height:72px}.multi-select{position:relative}.multi-trigger{width:100%;height:40px;border:1px solid #c8d2df;border-radius:6px;background:#fff;color:#0b1833;text-align:left;font-weight:650;display:flex;align-items:center;justify-content:space-between}.multi-trigger:after{content:"▾";color:#66758a}.multi-options{display:none;max-height:220px;overflow:auto;border:1px solid #c8d2df;border-radius:8px;background:#fff;box-shadow:0 8px 18px rgba(15,23,42,.08);padding:6px;margin-top:6px}.multi-select.open .multi-options{display:block}.multi-option{display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer}.multi-option:hover{background:#f4f7fb}.multi-option input{width:auto}.model-type-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;border:1px solid #c8d2df;border-radius:8px;padding:6px;background:#fff}.field-title{font-size:13px;font-weight:650;color:#24324a;margin-bottom:4px}.multi-empty{padding:10px;color:#66758a}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.list-toolbar{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:12px}.form-panel{display:none;margin:12px 0 16px;padding:14px;border:1px solid #cfd9e6;border-radius:8px;background:#fbfcfe}.form-panel.open{display:block}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{border:1px solid #dce3ec;border-radius:8px;padding:14px;background:#fbfcfe}.num{font-size:24px;font-weight:800}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:14px}th,td{border-bottom:1px solid #e2e8f0;padding:10px;text-align:left;vertical-align:top}code{font-family:Consolas,monospace}.formula{margin:12px 0;padding:12px;border:1px solid #dce3ec;border-radius:8px;background:#fbfcfe;color:#24324a;font-size:13px;line-height:1.7}.edit-box{display:none;margin:14px 0;padding:14px;border:1px solid #cfd9e6;border-radius:8px;background:#fbfcfe}.pill{display:inline-block;background:#eef2f7;border-radius:999px;padding:3px 8px;margin:2px}.pager{justify-content:space-between;margin-top:12px}.pager select{width:auto}.bulk-box{display:none;margin:14px 0;padding:14px;border:1px solid #cfd9e6;border-radius:8px;background:#fbfcfe}.bulk-list{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;max-height:260px;overflow:auto;margin:10px 0}.permission-dialog{width:min(560px,calc(100vw - 32px));border:0;border-radius:12px;padding:0;box-shadow:0 20px 60px rgba(15,23,42,.24)}.permission-dialog::backdrop{background:rgba(15,23,42,.42)}.permission-dialog-content{padding:20px}.permission-dialog-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.permission-dialog-head h2{margin:0;font-size:18px}.permission-group{margin-top:16px}.permission-group b{display:block;margin-bottom:8px}.permission-items{display:flex;gap:8px;flex-wrap:wrap}.status-ok{color:#0f8a43}.status-bad{color:#c02626}@media(max-width:960px){.grid,.grid-3,.grid-5,.cards,.bulk-list{grid-template-columns:1fr}header{display:block}.token{margin-top:12px}}
</style></head><body><main>
<header><div><h1>LfClaw 企业管理</h1><p class="hint">维护模型、MCP 服务和技能包，再给员工分配激活码、积分和能力。</p></div><div class="token"><label>管理员 Token<input id="token" type="password" placeholder="LFCLAW_ADMIN_TOKEN"></label><button class="secondary" id="refreshBtn">刷新</button></div></header>
<nav><button data-tab="overview" class="active-tab">总览</button><button data-tab="employees">员工与激活码</button><button data-tab="models">模型配置</button><button data-tab="mcp">MCP 服务</button><button data-tab="skills">技能包</button><button data-tab="asr">语音识别</button><button data-tab="usage">用量监控</button><button data-tab="backup">数据备份</button><button data-tab="release">版本更新</button></nav>
<section id="overview" class="active"><div class="cards"><div class="card"><div class="hint">员工数</div><div class="num" id="statEmployees">0</div></div><div class="card"><div class="hint">模型数</div><div class="num" id="statModels">0</div></div><div class="card"><div class="hint">MCP 数量</div><div class="num" id="statMcps">0</div></div><div class="card"><div class="hint">技能数量</div><div class="num" id="statSkills">0</div></div><div class="card"><div class="hint">调用次数</div><div class="num" id="statCalls">0</div></div><div class="card"><div class="hint">已用积分</div><div class="num" id="statCredits">0</div></div></div></section>
<section id="employees"><div class="list-toolbar"><div class="hint">员工列表默认每页 10 条，授权详情通过弹窗查看。</div><button id="newEmployeeBtn">新增员工</button></div><div id="employeeForm" class="form-panel"><div class="grid"><label>中文姓名<input id="employeeName" placeholder="张三"></label><label>员工 ID<input id="employeeId" placeholder="自动生成"></label><label>积分额度<input id="creditsLimit" type="number" value="1000"></label><label>备注<input id="notes"></label></div><div class="grid grid-3" style="margin-top:12px"><label>可用模型<div id="employeeModels" class="multi-select"></div></label><label>可用 MCP<div id="employeeMcps" class="multi-select"></div></label><label>可用技能<div id="employeeSkills" class="multi-select"></div></label></div><p class="hint">预览：<code id="employeePreview">输入中文姓名后自动生成员工 ID 与激活码前缀</code></p><div class="row"><button id="addEmployeeBtn">添加员工并生成激活码</button><button class="secondary" id="saveEmployeeBtn" style="display:none">保存员工授权</button><button class="secondary" id="cancelEmployeeBtn" style="display:none">取消编辑</button></div></div><table><thead><tr><th>状态</th><th>激活码</th><th>员工</th><th>积分/使用</th><th>最近客户端</th><th>设备</th><th>操作</th></tr></thead><tbody id="employeeRows"></tbody></table><div class="row pager"><div class="hint" id="employeePagerInfo"></div><div class="row"><label>每页<select id="employeePageSize"><option value="10" selected>10</option><option value="20">20</option><option value="50">50</option><option value="100">100</option></select></label><button class="secondary" id="employeePrevPage">上一页</button><button class="secondary" id="employeeNextPage">下一页</button></div></div></section>
<dialog id="permissionDialog" class="permission-dialog"><div class="permission-dialog-content"><div class="permission-dialog-head"><h2 id="permissionDialogTitle">员工授权</h2><button class="secondary" id="permissionDialogClose">关闭</button></div><div id="permissionDialogBody"></div></div></dialog>
<section id="models"><div class="list-toolbar"><div class="hint">一个模型保存一条配置，可编辑、测试连接后再分配员工。</div><button id="newModelBtn">新增模型</button></div><div id="modelForm" class="form-panel"><div class="grid"><label>模型 ID<input id="modelId" placeholder="glm-5.2"></label><label>模型名称<input id="modelName" placeholder="智谱 GLM-5.2"></label><label>Base URL<input id="modelBaseUrl" placeholder="https://open.bigmodel.cn/api/paas/v4"></label><label>API Key<input id="modelApiKey" type="password" placeholder="sk-..."></label></div><div class="grid" style="margin-top:12px"><label>计价货币<select id="billingCurrency"><option value="USD">USD</option><option value="CNY">CNY</option></select></label><label>输入价格 / 100万token<input id="inputPricePerMillionTokens" type="number" step="0.000001" value="0"></label><label>输出价格 / 100万token<input id="outputPricePerMillionTokens" type="number" step="0.000001" value="0"></label><label>1货币单位=企业积分<input id="creditsPerCurrencyUnit" type="number" step="0.01" value="10"></label></div><div class="grid" style="margin-top:12px"><label>缓存写入 / 100万token<input id="cacheWritePricePerMillionTokens" type="number" step="0.000001" value="0"></label><label>缓存读取 / 100万token<input id="cacheReadPricePerMillionTokens" type="number" step="0.000001" value="0"></label><label>固定积分/次<input id="fixedCreditsPerCall" type="number" step="0.01" value="0"></label><label>最低扣费积分<input id="minimumCreditsPerCall" type="number" step="0.01" value="1"></label><label>上下文窗口 / token<input id="modelContextWindow" type="number" step="1" min="0" placeholder="如 1000000"></label></div><div class="grid grid-3" style="margin-top:12px"><label>图片价格备注<input id="imagePriceNote"></label><label>语音价格备注<input id="audioPriceNote"></label><label>视频价格备注<input id="videoPriceNote"></label></div><div><div class="field-title">模型类型（可多选）</div><div id="modelTypes" class="model-type-options"><label class="multi-option"><input type="checkbox" data-model-type="text"> <span>文本模型</span></label><label class="multi-option"><input type="checkbox" data-model-type="multimodal-understanding"> <span>多模态理解</span></label><label class="multi-option"><input type="checkbox" data-model-type="image-generation"> <span>图片生成</span></label><label class="multi-option"><input type="checkbox" data-model-type="video-generation"> <span>视频生成</span></label><label class="multi-option"><input type="checkbox" data-model-type="speech-to-text"> <span>语音识别</span></label><label class="multi-option"><input type="checkbox" data-model-type="text-to-speech"> <span>语音合成</span></label><label class="multi-option"><input type="checkbox" data-model-type="audio-understanding"> <span>音频理解</span></label><label class="multi-option"><input type="checkbox" data-model-type="embedding"> <span>向量模型</span></label><label class="multi-option"><input type="checkbox" data-model-type="rerank"> <span>重排序模型</span></label><label class="multi-option"><input type="checkbox" data-model-type="ocr-document"> <span>OCR/文档解析</span></label></div></div><label>官方价格来源 URL<input id="priceSourceUrl" placeholder="官网 pricing 页面 URL"></label><div class="formula"><b>积分计算公式：</b>积分=max(最低扣费积分, 固定积分/次 + ((输入token×输入价格 + 输出token×输出价格 + 缓存写入token×缓存写入价格 + 缓存读取token×缓存读取价格) / 1000000) × 积分换算比例)</div><div class="row"><button id="saveModelBtn">保存模型</button><button class="secondary" id="testModelBtn">测试连接</button><button class="secondary" id="cancelModelBtn">取消编辑</button><span id="modelTestResult" class="hint"></span></div></div><table><thead><tr><th>模型 ID</th><th>名称</th><th>Base URL / 价格</th><th>Key</th><th>操作</th></tr></thead><tbody id="modelRows"></tbody></table></section>
<section id="mcp"><div class="list-toolbar"><div class="hint">先维护 MCP 服务，再分配给员工使用。</div><button id="newMcpBtn">新增 MCP</button></div><div id="mcpForm" class="form-panel"><div class="grid"><label>MCP ID<input id="mcpId" placeholder="qdrant-search"></label><label>名称<input id="mcpName"></label><label>类型<select id="mcpTransport"><option value="sse">SSE</option><option value="streamable-http">Streamable HTTP</option><option value="http">HTTP</option><option value="stdio">stdio</option></select></label><label>说明<input id="mcpDesc"></label></div><div class="grid" style="margin-top:12px"><label>服务 URL<input id="mcpUrl" placeholder="https://mcp.example.com/sse 或 /mcp"></label><label>Headers(JSON)<textarea id="mcpHeaders" placeholder='{"Authorization":"Bearer xxx"}'></textarea></label><label>命令(stdio)<input id="mcpCommand" placeholder="npx"></label><label>参数/环境变量<textarea id="mcpArgs" placeholder="参数每行一个；环境变量可后续补"></textarea></label></div><div class="row" style="margin-top:12px"><button id="saveMcpBtn">保存 MCP</button><button class="secondary" id="cancelMcpBtn">取消编辑</button></div></div><table><thead><tr><th>ID</th><th>名称</th><th>类型</th><th>连接</th><th>操作</th></tr></thead><tbody id="mcpRows"></tbody></table></section>
<section id="skills"><div class="list-toolbar"><div class="hint">上传企业技能包后，可批量分配给员工。</div><button id="newSkillBtn">新增技能</button></div><div id="skillForm" class="form-panel"><div class="grid"><label>技能 ID<input id="skillId" placeholder="sales-report"></label><label>名称<input id="skillName"></label><label>版本<input id="skillVersion" value="1.0.0"></label><label>说明<input id="skillDesc"></label></div><div class="grid" style="margin-top:12px"><label>技能压缩包(.zip)<input id="skillZip" type="file" accept=".zip,application/zip"></label><div><p class="hint">上传后服务端保存 zip，客户端按员工权限下载。</p><button id="uploadSkillBtn">上传/保存技能包</button><button class="secondary" id="cancelSkillBtn">取消编辑</button></div></div></div><div id="skillBulkBox" class="bulk-box"><b id="skillBulkTitle">批量分配授权</b><p class="hint">勾选需要拥有该授权的员工，保存后会一次性同步所有员工授权。</p><div class="row"><button class="secondary" id="skillBulkSelectAll">全部员工</button><button class="secondary" id="skillBulkClear">清空</button><button id="skillBulkSave">保存分配</button><button class="secondary" id="skillBulkCancel">取消</button></div><div id="skillBulkEmployees" class="bulk-list"></div></div><table><thead><tr><th>ID</th><th>名称</th><th>版本</th><th>包</th><th>操作</th></tr></thead><tbody id="skillRows"></tbody></table></section>
<section id="asr"><div class="formula"><b>全局语音输入：</b>语音能力不按员工单独授权。所有已激活员工都可使用；API Key 只保存在服务端，客户端只拿临时代理地址。</div><div class="grid"><label>显示名称<input id="asrName" placeholder="阿里云实时语音识别"></label><label>Workspace ID<input id="asrWorkspaceId" placeholder="llm-xxxx"></label><label>地域<input id="asrRegion" placeholder="cn-beijing"></label><label>模型<input id="asrModel" placeholder="fun-asr-realtime"></label></div><div class="grid" style="margin-top:12px"><label>API Host<input id="asrApiHost" placeholder="llm-xxx.cn-beijing.maas.aliyuncs.com"></label><label>WebSocket URL<input id="asrWebsocketUrl" placeholder="留空则按 Workspace 自动生成"></label><label>API Key<input id="asrApiKey" type="password" placeholder="sk-..."></label><label>音频格式<select id="asrFormat"><option value="wav">wav</option><option value="pcm">pcm</option></select></label></div><div class="grid" style="margin-top:12px"><label>采样率<input id="asrSampleRate" type="number" value="16000"></label><label>分片间隔(ms)<input id="asrChunkIntervalMillis" type="number" value="200"></label><label>单次最长录音(s)<input id="asrMaxSessionSeconds" type="number" value="60"></label><label>价格备注<input id="asrPriceNote" placeholder="如按秒/分钟计费"></label></div><div id="asrStatus" class="formula"></div><div class="row"><button id="saveAsrBtn">保存语音配置</button><button class="secondary" id="cancelAsrBtn">重置表单</button></div></section>
<section id="usage"><div class="formula"><b>用量扣费说明：</b>客户端上报模型调用后，服务端按模型价格计算积分，并按天汇总展示。</div><div class="grid grid-5"><label>员工筛选<select id="usageEmployeeFilter"><option value="">全部员工</option></select></label><label>模型筛选<select id="usageModelFilter"><option value="">全部模型</option></select></label><div class="card"><div class="hint">调用次数</div><div class="num" id="usageCalls">0</div></div><div class="card"><div class="hint">消耗积分</div><div class="num" id="usageCredits">0</div></div><div class="card"><div class="hint">折算金额</div><div class="num" id="usageMoney">-</div></div></div><table><thead><tr><th>时间（天）</th><th>员工</th><th>模型</th><th>使用 token</th><th>积分</th><th>折算金额</th></tr></thead><tbody id="usageRows"></tbody></table><div class="row pager"><div class="hint" id="usagePagerInfo"></div><div class="row"><button class="secondary" id="usagePrevPage">上一页</button><button class="secondary" id="usageNextPage">下一页</button></div></div></section>
<section id="backup"><div class="formula"><b>数据位置：</b>当前企业数据固定保存在 data/enterprise-data.json；备份保存在 data/backups，更新 server.mjs 不会覆盖这里。</div><div class="row"><button id="createBackupBtn">创建备份</button><button class="secondary" id="exportDataBtn">导出当前数据</button></div><table><thead><tr><th>备份文件</th><th>大小</th><th>时间</th><th>操作</th></tr></thead><tbody id="backupRows"></tbody></table></section>
<section id="release"><div class="formula"><b>自动更新源：</b>把安装包上传到 <code>/opt/LfClaw/releases</code>，文件名带日期流水号即可自动识别，无需手动填写下载地址。示例：<code>LfClaw-Setup-2026071501-win-x64-official.exe</code>、<code>LfClaw-2026071501-mac-arm64-official.dmg</code>。更新日志可放 <code>changelog-2026071501.zh.txt</code>，一行一条。</div><div id="releaseSummary" class="formula"></div><input id="releaseVersion" type="hidden"><input id="releaseDate" type="hidden"><input id="releaseWinUrl" type="hidden"><input id="releaseMacArmUrl" type="hidden"><input id="releaseMacIntelUrl" type="hidden"><input id="releaseManualUrl" type="hidden"><textarea id="releaseNotesZh" style="display:none"></textarea><textarea id="releaseNotesEn" style="display:none"></textarea><div class="row" style="margin-top:12px"><button class="secondary" id="testReleaseBtn">查看自动生成的更新 JSON</button><button id="saveReleaseBtn" style="display:none">保存更新信息</button></div></section>
</main><script>
var state={modelProviders:[],mcpServers:[],skills:[],employees:[],usageEvents:[],backups:[],release:{},asr:{}};var editingEmployee='';var employeePage=1;var employeePageSize=10;var usagePage=1;var usagePageSize=10;var bulkGrant={type:'',id:''};var $=function(id){return document.getElementById(id);};var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(s){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s];});};var headers=function(json){localStorage.setItem('lfclaw_admin_token',$('token').value);var h={authorization:'Bearer '+$('token').value};if(json!==false)h['content-type']='application/json';return h;};var api=async function(path,opt){opt=opt||{};var res=await fetch(path,Object.assign({},opt,{headers:Object.assign({},headers(),opt.headers||{})}));var text=await res.text();var body=text?JSON.parse(text):{};if(!res.ok||body.code!==0)throw new Error(body.message||'请求失败');return body.data;};var run=async function(fn){try{await fn();}catch(e){alert(e.message||String(e));}};var openForm=function(id){$(id).classList.add('open');};var closeForm=function(id){$(id).classList.remove('open');};var multiItems={employeeModels:[],employeeMcps:[],employeeSkills:[]};var multiValues={employeeModels:[],employeeMcps:[],employeeSkills:[]};var selected=function(id){return multiValues[id]||[];};var setSelected=function(id,values){multiValues[id]=Array.from(new Set(values||[]));renderMultiSelect(id);};var set=function(id,v){$(id).value=v==null?'':v;};
function showTab(tab){document.querySelectorAll('section').forEach(function(s){s.classList.toggle('active',s.id===tab);});document.querySelectorAll('nav button').forEach(function(b){b.classList.toggle('active-tab',b.dataset.tab===tab);});}
function renderMultiSelect(id){var items=multiItems[id]||[];var values=new Set(multiValues[id]||[]);var selectedItems=items.filter(function(x){return values.has(x.id);});var title=selectedItems.length?selectedItems.map(function(x){return x.name||x.id;}).join(', '):'未选择';$(id).innerHTML='<button type="button" class="multi-trigger" data-multi-toggle="'+id+'">'+esc(title)+'</button><div class="multi-options">'+(items.length?items.map(function(x){return '<label class="multi-option"><input type="checkbox" data-multi-id="'+id+'" data-multi-value="'+esc(x.id)+'" '+(values.has(x.id)?'checked':'')+'> <span>'+esc(x.name||x.id)+' ('+esc(x.id)+')</span></label>';}).join(''):'<div class="multi-empty">暂无可选项</div>')+'</div>';}function fillSelect(id,items){multiItems[id]=(items||[]).filter(function(x){return x.enabled!==false;});multiValues[id]=(multiValues[id]||[]).filter(function(value){return multiItems[id].some(function(item){return item.id===value;});});renderMultiSelect(id);}
async function loadAll(){state=await api('/api/admin/state');state.modelProviders=state.modelProviders||state.models||[];renderAll();}
function renderAll(){fillSelect('employeeModels',state.modelProviders);fillSelect('employeeMcps',state.mcpServers);fillSelect('employeeSkills',state.skills);renderOverview();renderEmployees();renderModels();renderMcp();renderSkills();renderAsr();renderUsageFilters();renderUsage();renderBackups();renderRelease();}
function authText(v){return (v&&v.length)?v.join(', '):'未授权';}
function renderOverview(){var modelIds=state.modelProviders.flatMap(function(provider){var models=provider.models||[];return models.length?models.map(function(model){return model.id;}):[provider.id];}).filter(Boolean);$('statEmployees').textContent=state.employees.length;$('statModels').textContent=new Set(modelIds).size;$('statMcps').textContent=state.mcpServers.length;$('statSkills').textContent=state.skills.length;$('statCalls').textContent=state.usageEvents.length;$('statCredits').textContent=state.usageEvents.reduce(function(s,e){return s+Number(e.credits||0);},0).toFixed(2);}
function renderEmployees(){var total=state.employees.length;var pages=Math.max(1,Math.ceil(total/employeePageSize));employeePage=Math.min(Math.max(1,employeePage),pages);var start=(employeePage-1)*employeePageSize;var rows=state.employees.slice(start,start+employeePageSize);$('employeeRows').innerHTML=rows.map(function(e){return '<tr><td>'+esc(e.status)+'</td><td><code>'+esc(e.activationCode)+'</code></td><td>'+esc(e.employeeName)+'<br><code>'+esc(e.employeeId)+'</code></td><td>'+esc(Math.max(0,(e.creditsLimit||0)-(e.creditsUsed||0)))+'/'+esc(e.creditsLimit||0)+'<br><button class="secondary" data-act="credits" data-code="'+esc(e.activationCode)+'">改积分</button></td><td><code>'+esc(e.lastSeenClientVersion||e.clientVersion||'-')+'</code><br>'+esc(e.lastSeenClientVersionAt||'-')+'</td><td><code>'+esc(e.deviceToken||'-')+'</code><br>'+esc(e.lastUsedAt||'-')+'</td><td><div class="row"><button class="secondary" data-act="viewGrants" data-code="'+esc(e.activationCode)+'">授权</button><button class="secondary" data-act="editEmployee" data-code="'+esc(e.activationCode)+'">编辑</button><button class="secondary" data-act="copy" data-code="'+esc(e.activationCode)+'">复制</button><button class="secondary" data-act="toggle" data-code="'+esc(e.activationCode)+'" data-status="'+esc(e.status)+'">'+(e.status==='active'?'禁用':'启用')+'</button><button class="danger" data-act="deleteEmployee" data-code="'+esc(e.activationCode)+'">删除</button></div></td></tr>';}).join('');$('employeePagerInfo').textContent=total?'第 '+employeePage+' / '+pages+' 页，共 '+total+' 人，当前显示 '+(start+1)+'-'+Math.min(start+rows.length,total):'暂无员工';$('employeePrevPage').disabled=employeePage<=1;$('employeeNextPage').disabled=employeePage>=pages;$('employeePageSize').value=String(employeePageSize);}
function grantNames(ids,items){return (ids||[]).map(function(id){var item=(items||[]).find(function(x){return x.id===id;});return item?(item.name||item.id):id;});}
function grantGroup(title,ids,items){var names=grantNames(ids,items);return '<div class="permission-group"><b>'+esc(title)+'</b><div class="permission-items">'+(names.length?names.map(function(name){return '<span class="pill">'+esc(name)+'</span>';}).join(''):'<span class="hint">未授权</span>')+'</div></div>';}
function showEmployeeGrants(code){var e=state.employees.find(function(x){return x.activationCode===code;});if(!e)return;$('permissionDialogTitle').textContent=(e.employeeName||e.employeeId)+' 的授权';$('permissionDialogBody').innerHTML=grantGroup('模型',e.allowedModelProviderIds,state.modelProviders)+grantGroup('MCP',e.allowedMcpServerIds,state.mcpServers)+grantGroup('技能',e.allowedSkillIds,state.skills);$('permissionDialog').showModal();}
function bulkGrantConfig(){return{model:{title:'模型',section:'models',items:state.modelProviders,grantKey:'allowedModelProviderIds',path:'/api/admin/model-providers'},mcp:{title:'MCP',section:'mcp',items:state.mcpServers,grantKey:'allowedMcpServerIds',path:'/api/admin/mcp'},skill:{title:'技能',section:'skills',items:state.skills,grantKey:'allowedSkillIds',path:'/api/admin/skills'}};}
function renderModels(){$('modelRows').innerHTML=state.modelProviders.map(function(x){var m=(x.models||[])[0]||{};var b=x.billing||{};return '<tr><td><code>'+esc(m.id||x.id)+'</code></td><td>'+esc(m.name||x.name)+'</td><td>'+esc(x.baseUrl)+'<br><span class="hint">'+esc(b.currency||'')+' 输入 '+esc(b.inputPricePerMillionTokens||0)+'/M，输出 '+esc(b.outputPricePerMillionTokens||0)+'/M</span></td><td>'+esc(x.apiKey?'********':'-')+'</td><td><div class="row"><button class="secondary" data-act="editModel" data-id="'+esc(x.id)+'">编辑</button><button class="secondary" data-act="bulkGrant" data-type="model" data-id="'+esc(x.id)+'">分配员工</button><button class="danger" data-act="delete" data-path="/api/admin/model-providers" data-id="'+esc(x.id)+'">删除</button></div></td></tr>';}).join('');renderBulkGrant();}
function renderMcp(){$('mcpRows').innerHTML=state.mcpServers.map(function(x){var link=x.transportType==='stdio'?(x.command+' '+(x.args||[]).join(' ')):x.url;return '<tr><td><code>'+esc(x.id)+'</code></td><td>'+esc(x.name)+'</td><td>'+esc(x.transportType)+'</td><td>'+esc(link)+'</td><td><div class="row"><button class="secondary" data-act="editMcp" data-id="'+esc(x.id)+'">编辑</button><button class="secondary" data-act="bulkGrant" data-type="mcp" data-id="'+esc(x.id)+'">分配员工</button><button class="danger" data-act="delete" data-path="/api/admin/mcp" data-id="'+esc(x.id)+'">删除</button></div></td></tr>';}).join('');renderBulkGrant();}
function renderSkills(){$('skillRows').innerHTML=state.skills.map(function(x){return '<tr><td><code>'+esc(x.id)+'</code></td><td>'+esc(x.name)+'</td><td>'+esc(x.version||'-')+'</td><td>'+esc(x.packageFileName||'-')+'</td><td><div class="row"><button class="secondary" data-act="editSkill" data-id="'+esc(x.id)+'">编辑</button><button class="secondary" data-act="bulkGrant" data-type="skill" data-id="'+esc(x.id)+'">分配员工</button><button class="danger" data-act="delete" data-path="/api/admin/skills" data-id="'+esc(x.id)+'">删除</button></div></td></tr>';}).join('');renderBulkGrant();}
function renderBulkGrant(){var box=$('skillBulkBox');if(!box)return;var configs=bulkGrantConfig();var cfg=configs[bulkGrant.type];if(!cfg||!bulkGrant.id){box.style.display='none';return;}var item=(cfg.items||[]).find(function(x){return x.id===bulkGrant.id;});if(!item){bulkGrant={type:'',id:''};box.style.display='none';return;}var section=$(cfg.section);if(section&&box.parentElement!==section){var table=section.querySelector('table');section.insertBefore(box,table||null);}$('skillBulkTitle').textContent='批量分配'+cfg.title+'：'+(item.name||item.id);$('skillBulkEmployees').innerHTML=state.employees.map(function(e){var checked=(e[cfg.grantKey]||[]).indexOf(bulkGrant.id)>=0;return '<label class="multi-option"><input type="checkbox" data-bulk-grant-employee="'+esc(e.activationCode)+'" '+(checked?'checked':'')+'> <span>'+esc(e.employeeName)+' / '+esc(e.employeeId)+'</span></label>';}).join('')||'<div class="multi-empty">暂无员工</div>';box.style.display='block';}
function renderAsr(){var x=state.asr||{};set('asrName',x.name||'阿里云实时语音识别');set('asrWorkspaceId',x.workspaceId||'');set('asrRegion',x.region||'cn-beijing');set('asrApiHost',x.apiHost||'');set('asrWebsocketUrl',x.websocketUrl||'');set('asrApiKey','');$('asrApiKey').placeholder=x.apiKey?'已保存，留空则不修改':'sk-...';set('asrModel',x.model||'fun-asr-realtime');set('asrFormat',x.format||'wav');set('asrSampleRate',x.sampleRate||16000);set('asrChunkIntervalMillis',x.chunkIntervalMillis||200);set('asrMaxSessionSeconds',x.maxSessionSeconds||60);set('asrPriceNote',x.priceNote||'');$('asrStatus').innerHTML=x.configured?'<b>当前状态：</b>已配置，客户端企业激活后即可使用语音输入。':'<b>当前状态：</b>未配置，请填写 API Key，并填写 Workspace ID / API Host / WebSocket URL 之一。';}
function asrPayload(){return{name:$('asrName').value,workspaceId:$('asrWorkspaceId').value,region:$('asrRegion').value,apiHost:$('asrApiHost').value,websocketUrl:$('asrWebsocketUrl').value,apiKey:$('asrApiKey').value,model:$('asrModel').value,format:$('asrFormat').value,sampleRate:Number($('asrSampleRate').value),chunkIntervalMillis:Number($('asrChunkIntervalMillis').value),maxSessionSeconds:Number($('asrMaxSessionSeconds').value),priceNote:$('asrPriceNote').value};}
function selectedModelTypes(){return Array.from(document.querySelectorAll('[data-model-type]:checked')).map(function(o){return o.getAttribute('data-model-type');}).filter(Boolean);}
function modelTypesSupportImage(types){return types.indexOf('multimodal-understanding')>=0||types.indexOf('ocr-document')>=0;}
function modelPayload(){var mid=$('modelId').value.trim();var modelTypes=selectedModelTypes();return{id:mid,modelId:mid,name:$('modelName').value||mid,modelName:$('modelName').value||mid,baseUrl:$('modelBaseUrl').value,apiKey:$('modelApiKey').value,apiFormat:'openai',supportsImage:modelTypesSupportImage(modelTypes),modelTypes:modelTypes,currency:$('billingCurrency').value,inputPricePerMillionTokens:Number($('inputPricePerMillionTokens').value),outputPricePerMillionTokens:Number($('outputPricePerMillionTokens').value),cacheWritePricePerMillionTokens:Number($('cacheWritePricePerMillionTokens').value),cacheReadPricePerMillionTokens:Number($('cacheReadPricePerMillionTokens').value),creditsPerCurrencyUnit:Number($('creditsPerCurrencyUnit').value),fixedCreditsPerCall:Number($('fixedCreditsPerCall').value),minimumCreditsPerCall:Number($('minimumCreditsPerCall').value),contextWindow:Number($('modelContextWindow').value),imagePriceNote:$('imagePriceNote').value,audioPriceNote:$('audioPriceNote').value,videoPriceNote:$('videoPriceNote').value,priceSourceUrl:$('priceSourceUrl').value};}
function editModel(id){var x=state.modelProviders.find(function(i){return i.id===id;});if(!x)return;var m=(x.models||[])[0]||{};var b=x.billing||{};var types=Array.isArray(x.modelTypes)?x.modelTypes:(Array.isArray(m.modelTypes)?m.modelTypes:[]);set('modelId',m.id||x.id);$('modelId').readOnly=true;set('modelName',m.name||x.name);set('modelBaseUrl',x.baseUrl);set('modelApiKey','');$('modelApiKey').placeholder=x.apiKey?'已保存，留空则不修改':'sk-...';Array.from(document.querySelectorAll('[data-model-type]')).forEach(function(o){o.checked=types.indexOf(o.getAttribute('data-model-type'))>=0;});set('billingCurrency',b.currency||'USD');set('inputPricePerMillionTokens',b.inputPricePerMillionTokens||0);set('outputPricePerMillionTokens',b.outputPricePerMillionTokens||0);set('cacheWritePricePerMillionTokens',b.cacheWritePricePerMillionTokens||0);set('cacheReadPricePerMillionTokens',b.cacheReadPricePerMillionTokens||0);set('creditsPerCurrencyUnit',b.creditsPerCurrencyUnit||10);set('fixedCreditsPerCall',b.fixedCreditsPerCall||0);set('minimumCreditsPerCall',b.minimumCreditsPerCall==null?1:b.minimumCreditsPerCall);set('modelContextWindow',m.contextWindow||x.contextWindow||'');set('imagePriceNote',b.imagePriceNote||'');set('audioPriceNote',b.audioPriceNote||'');set('videoPriceNote',b.videoPriceNote||'');set('priceSourceUrl',b.sourceUrl||'');openForm('modelForm');showTab('models');}
function clearModel(){$('modelId').readOnly=false;$('modelApiKey').placeholder='sk-...';Array.from(document.querySelectorAll('[data-model-type]')).forEach(function(o){o.checked=false;});['modelId','modelName','modelBaseUrl','modelApiKey','imagePriceNote','audioPriceNote','videoPriceNote','priceSourceUrl'].forEach(function(id){set(id,'');});set('billingCurrency','USD');set('inputPricePerMillionTokens',0);set('outputPricePerMillionTokens',0);set('cacheWritePricePerMillionTokens',0);set('cacheReadPricePerMillionTokens',0);set('creditsPerCurrencyUnit',10);set('fixedCreditsPerCall',0);set('minimumCreditsPerCall',1);set('modelContextWindow','');$('modelTestResult').textContent='';closeForm('modelForm');}
function editMcp(id){var x=state.mcpServers.find(function(i){return i.id===id;});if(!x)return;set('mcpId',x.id);$('mcpId').readOnly=true;set('mcpName',x.name);set('mcpDesc',x.description);set('mcpTransport',x.transportType||'sse');set('mcpUrl',x.url);set('mcpHeaders',JSON.stringify(x.headers||{},null,2));set('mcpCommand',x.command);set('mcpArgs',(x.args||[]).join('\n'));openForm('mcpForm');showTab('mcp');}
function clearMcp(){$('mcpId').readOnly=false;['mcpId','mcpName','mcpDesc','mcpUrl','mcpHeaders','mcpCommand','mcpArgs'].forEach(function(id){set(id,'');});set('mcpTransport','sse');closeForm('mcpForm');}
function editSkill(id){var x=state.skills.find(function(i){return i.id===id;});if(!x)return;set('skillId',x.id);$('skillId').readOnly=true;set('skillName',x.name);set('skillVersion',x.version||'1.0.0');set('skillDesc',x.description);$('skillZip').value='';openForm('skillForm');showTab('skills');}
function clearSkill(){$('skillId').readOnly=false;['skillId','skillName','skillDesc'].forEach(function(id){set(id,'');});set('skillVersion','1.0.0');$('skillZip').value='';closeForm('skillForm');}
function editEmployee(code){var e=state.employees.find(function(x){return x.activationCode===code;});if(!e)return;editingEmployee=code;set('employeeName',e.employeeName);set('employeeId',e.employeeId);set('creditsLimit',e.creditsLimit);set('notes',e.notes);setSelected('employeeModels',e.allowedModelProviderIds);setSelected('employeeMcps',e.allowedMcpServerIds);setSelected('employeeSkills',e.allowedSkillIds);$('addEmployeeBtn').style.display='none';$('saveEmployeeBtn').style.display='inline-block';$('cancelEmployeeBtn').style.display='inline-block';openForm('employeeForm');showTab('employees');}
function clearEmployee(){editingEmployee='';['employeeName','employeeId','notes'].forEach(function(id){set(id,'');});set('creditsLimit',1000);setSelected('employeeModels',[]);setSelected('employeeMcps',[]);setSelected('employeeSkills',[]);$('addEmployeeBtn').style.display='inline-block';$('saveEmployeeBtn').style.display='none';$('cancelEmployeeBtn').style.display='none';closeForm('employeeForm');}
async function copyCode(code){var done=false;try{var input=document.createElement('textarea');input.value=code;input.setAttribute('readonly','');input.style.position='fixed';input.style.left='-9999px';input.style.top='0';document.body.appendChild(input);input.focus();input.select();input.setSelectionRange(0,input.value.length);done=document.execCommand('copy');document.body.removeChild(input);}catch(e){}if(!done&&navigator.clipboard){try{await navigator.clipboard.writeText(code);done=true;}catch(e){}}if(done){alert('已复制激活码：'+code);}else{prompt('自动复制失败，请手动复制激活码',code);}}
function renderUsageFilters(){$('usageEmployeeFilter').innerHTML='<option value="">全部员工</option>'+state.employees.map(function(e){return '<option value="'+esc(e.employeeId)+'">'+esc(e.employeeName)+' ('+esc(e.employeeId)+')</option>';}).join('');var models=[].concat.apply([],state.modelProviders.map(function(p){return (p.models||[]).map(function(m){return m.id;});}));models=Array.from(new Set(models));$('usageModelFilter').innerHTML='<option value="">全部模型</option>'+models.map(function(m){return '<option value="'+esc(m)+'">'+esc(m)+'</option>';}).join('');}
function providerByModel(modelId){return state.modelProviders.find(function(p){return (p.models||[]).some(function(m){return m.id===modelId;});});}function money(credits,modelId){var b=(providerByModel(modelId)||{}).billing||{};var rate=Number(b.creditsPerCurrencyUnit||0);return rate?(b.currency||'USD')+' '+(Number(credits||0)/rate).toFixed(4):'-';}
function renderUsage(){var eid=$('usageEmployeeFilter').value;var mid=$('usageModelFilter').value;var rows={};var events=state.usageEvents.filter(function(e){return (!eid||e.employeeId===eid)&&(!mid||e.modelId===mid);});events.forEach(function(e){var day=String(e.createdAt||'').slice(0,10)||'-';var key=day+'|'+e.employeeId+'|'+e.modelId;rows[key]=rows[key]||{day:day,employeeId:e.employeeId,modelId:e.modelId,tokens:0,credits:0};rows[key].tokens+=Number(e.inputTokens||0)+Number(e.outputTokens||0)+Number(e.cacheWriteTokens||0)+Number(e.cacheReadTokens||0);rows[key].credits+=Number(e.credits||0);});var allRows=Object.values(rows).sort(function(a,b){return String(b.day).localeCompare(String(a.day))||String(a.employeeId).localeCompare(String(b.employeeId))||String(a.modelId).localeCompare(String(b.modelId));});var total=allRows.length;var pages=Math.max(1,Math.ceil(total/usagePageSize));usagePage=Math.min(Math.max(1,usagePage),pages);var start=(usagePage-1)*usagePageSize;var pageRows=allRows.slice(start,start+usagePageSize);$('usageCalls').textContent=events.length;$('usageCredits').textContent=events.reduce(function(s,e){return s+Number(e.credits||0);},0).toFixed(4);$('usageMoney').textContent='-';$('usageRows').innerHTML=pageRows.map(function(r){var emp=state.employees.find(function(e){return e.employeeId===r.employeeId;});return '<tr><td>'+esc(r.day)+'</td><td>'+esc(emp?emp.employeeName:r.employeeId)+'<br><code>'+esc(r.employeeId)+'</code></td><td>'+esc(r.modelId)+'</td><td>'+r.tokens+'</td><td>'+r.credits.toFixed(4)+'</td><td>'+esc(money(r.credits,r.modelId))+'</td></tr>';}).join('');$('usagePagerInfo').textContent=total?'第 '+usagePage+' / '+pages+' 页，共 '+total+' 条，当前显示 '+(start+1)+'-'+Math.min(start+pageRows.length,total):'暂无用量记录';$('usagePrevPage').disabled=usagePage<=1;$('usageNextPage').disabled=usagePage>=pages;}
function downloadAdmin(path,name){return run(async function(){var res=await fetch(path,{headers:headers(false)});if(!res.ok)throw new Error('下载失败');var blob=await res.blob();var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download=name||'';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);});}
function renderBackups(){if(!$('backupRows'))return;var backups=state.backups||[];$('backupRows').innerHTML=backups.map(function(b){return '<tr><td><code>'+esc(b.name)+'</code></td><td>'+Math.ceil(Number(b.size||0)/1024)+' KB</td><td>'+esc(b.createdAt||'-')+'</td><td><button class="secondary" data-act="downloadBackup" data-name="'+esc(b.name)+'">下载</button></td></tr>';}).join('')||'<tr><td colspan="4" class="hint">暂无备份</td></tr>';}
async function renderRelease(){if(!$('releaseVersion'))return;var r=state.release||{};set('releaseVersion',r.version||'');set('releaseDate',r.date||'');set('releaseWinUrl',r.windowsX64Url||'');set('releaseMacArmUrl',r.macArmUrl||'');set('releaseMacIntelUrl',r.macIntelUrl||'');set('releaseManualUrl',r.manualUrl||'');set('releaseNotesZh',r.notesZh||'');set('releaseNotesEn',r.notesEn||'');if($('releaseSummary')){try{var res=await fetch('/api/enterprise/update');var body=await res.json();var v=(body.data||{}).value||{};$('releaseSummary').innerHTML='<b>当前自动生成：</b><br>版本：<code>'+esc(v.version||'未检测到安装包')+'</code><br>发布日期：'+esc(v.date||'-')+'<br>Windows：'+esc((v.windowsX64||{}).url||'-')+'<br>macOS Apple Silicon：'+esc((v.macArm||{}).url||'-')+'<br>macOS Intel：'+esc((v.macIntel||{}).url||'-')+'<br>更新日志：'+esc((((v.changeLog||{}).ch||{}).content||[]).join('；')||'-');}catch(e){$('releaseSummary').textContent='暂时无法读取更新 JSON：'+(e.message||e);}}}
document.querySelector('nav').onclick=function(e){if(e.target.dataset.tab)showTab(e.target.dataset.tab);};$('refreshBtn').onclick=function(){run(loadAll);};$('token').value=localStorage.getItem('lfclaw_admin_token')||'lfclaw-admin';$('permissionDialogClose').onclick=function(){$('permissionDialog').close();};$('permissionDialog').onclick=function(e){if(e.target===$('permissionDialog'))$('permissionDialog').close();};$('employeeName').oninput=function(){run(async function(){var d=await api('/api/admin/pinyin?name='+encodeURIComponent($('employeeName').value));$('employeePreview').textContent=d.employeeId+' / '+d.activationPrefix;if(!$('employeeId').value)$('employeeId').placeholder=d.employeeId;});};$('newEmployeeBtn').onclick=function(){clearEmployee();openForm('employeeForm');};$('addEmployeeBtn').onclick=function(){run(async function(){await api('/api/admin/employees',{method:'POST',body:JSON.stringify({employeeName:$('employeeName').value,employeeId:$('employeeId').value,creditsLimit:Number($('creditsLimit').value),notes:$('notes').value,allowedModelProviderIds:selected('employeeModels'),allowedMcpServerIds:selected('employeeMcps'),allowedSkillIds:selected('employeeSkills')})});clearEmployee();employeePage=1;await loadAll();});};$('saveEmployeeBtn').onclick=function(){run(async function(){await api('/api/admin/employees/'+encodeURIComponent(editingEmployee),{method:'PATCH',body:JSON.stringify({employeeName:$('employeeName').value,employeeId:$('employeeId').value,creditsLimit:Number($('creditsLimit').value),notes:$('notes').value,allowedModelProviderIds:selected('employeeModels'),allowedMcpServerIds:selected('employeeMcps'),allowedSkillIds:selected('employeeSkills')})});clearEmployee();await loadAll();});};$('cancelEmployeeBtn').onclick=clearEmployee;$('employeePrevPage').onclick=function(){employeePage=Math.max(1,employeePage-1);renderEmployees();};$('employeeNextPage').onclick=function(){employeePage+=1;renderEmployees();};$('employeePageSize').onchange=function(){employeePageSize=Number($('employeePageSize').value)||10;employeePage=1;renderEmployees();};$('newModelBtn').onclick=function(){clearModel();openForm('modelForm');};$('saveModelBtn').onclick=function(){run(async function(){await api('/api/admin/model-providers',{method:'POST',body:JSON.stringify(modelPayload())});clearModel();await loadAll();});};$('testModelBtn').onclick=function(){run(async function(){$('modelTestResult').textContent='测试中...';$('modelTestResult').className='hint';var result=await api('/api/admin/model-providers/test',{method:'POST',body:JSON.stringify(modelPayload())});$('modelTestResult').textContent=result.ok?'连接成功：'+(result.model||$('modelId').value):'连接失败：'+(result.message||'未知错误');$('modelTestResult').className=result.ok?'hint status-ok':'hint status-bad';});};$('cancelModelBtn').onclick=clearModel;$('newMcpBtn').onclick=function(){clearMcp();openForm('mcpForm');};$('saveMcpBtn').onclick=function(){run(async function(){await api('/api/admin/mcp',{method:'POST',body:JSON.stringify({id:$('mcpId').value.trim(),name:$('mcpName').value,description:$('mcpDesc').value,transportType:$('mcpTransport').value,url:$('mcpUrl').value,headers:$('mcpHeaders').value,command:$('mcpCommand').value,args:$('mcpArgs').value.split(/\r?\n|,/).map(function(x){return x.trim();}).filter(Boolean)} )});clearMcp();await loadAll();});};$('cancelMcpBtn').onclick=clearMcp;$('newSkillBtn').onclick=function(){clearSkill();openForm('skillForm');};$('uploadSkillBtn').onclick=function(){run(async function(){var fd=new FormData();fd.set('id',$('skillId').value.trim());fd.set('name',$('skillName').value);fd.set('version',$('skillVersion').value);fd.set('description',$('skillDesc').value);if($('skillZip').files[0])fd.set('package',$('skillZip').files[0]);var res=await fetch('/api/admin/skills/upload',{method:'POST',headers:headers(false),body:fd});var text=await res.text();var body=text?JSON.parse(text):{};if(!res.ok||body.code!==0)throw new Error(body.message||'上传失败');clearSkill();await loadAll();});};$('cancelSkillBtn').onclick=clearSkill;$('saveAsrBtn').onclick=function(){run(async function(){await api('/api/admin/asr',{method:'POST',body:JSON.stringify(asrPayload())});await loadAll();alert('语音识别配置已保存');});};$('cancelAsrBtn').onclick=renderAsr;$('usageEmployeeFilter').onchange=function(){usagePage=1;renderUsage();};$('usageModelFilter').onchange=function(){usagePage=1;renderUsage();};$('usagePrevPage').onclick=function(){usagePage=Math.max(1,usagePage-1);renderUsage();};$('usageNextPage').onclick=function(){usagePage+=1;renderUsage();};$('createBackupBtn').onclick=function(){run(async function(){await api('/api/admin/backups',{method:'POST',body:'{}'});await loadAll();alert('备份已创建');});};$('exportDataBtn').onclick=function(){downloadAdmin('/api/admin/export','enterprise-data.json');};$('saveReleaseBtn').onclick=function(){run(async function(){await api('/api/admin/release',{method:'POST',body:JSON.stringify({version:$('releaseVersion').value,date:$('releaseDate').value,windowsX64Url:$('releaseWinUrl').value,macArmUrl:$('releaseMacArmUrl').value,macIntelUrl:$('releaseMacIntelUrl').value,manualUrl:$('releaseManualUrl').value,notesZh:$('releaseNotesZh').value,notesEn:$('releaseNotesEn').value})});await loadAll();alert('更新信息已保存');});};$('testReleaseBtn').onclick=function(){window.open('/api/enterprise/update','_blank');};
document.body.onchange=function(e){var t=e.target;if(!t.dataset.multiId)return;var id=t.dataset.multiId;var value=t.dataset.multiValue;var set=new Set(multiValues[id]||[]);if(t.checked)set.add(value);else set.delete(value);multiValues[id]=Array.from(set);renderMultiSelect(id);$(id).classList.add('open');};
document.body.onclick=function(e){var t=e.target;if(t.dataset.multiToggle){$(t.dataset.multiToggle).classList.toggle('open');return;}var a=t.dataset.act;if(!a)return;run(async function(){if(a==='viewGrants')showEmployeeGrants(t.dataset.code);if(a==='editEmployee')editEmployee(t.dataset.code);if(a==='copy')await copyCode(t.dataset.code);if(a==='toggle'){await api('/api/admin/employees/'+encodeURIComponent(t.dataset.code),{method:'PATCH',body:JSON.stringify({status:t.dataset.status==='active'?'disabled':'active'})});await loadAll();}if(a==='credits'){var v=prompt('新积分额度');if(v!==null){await api('/api/admin/employees/'+encodeURIComponent(t.dataset.code),{method:'PATCH',body:JSON.stringify({creditsLimit:Number(v)})});await loadAll();}}if(a==='deleteEmployee'){if(confirm('确定删除？')){await api('/api/admin/employees/'+encodeURIComponent(t.dataset.code),{method:'DELETE'});await loadAll();}}if(a==='editModel')editModel(t.dataset.id);if(a==='editMcp')editMcp(t.dataset.id);if(a==='editSkill')editSkill(t.dataset.id);if(a==='downloadBackup')downloadAdmin('/api/admin/backups/'+encodeURIComponent(t.dataset.name)+'/download',t.dataset.name);if(a==='delete'){if(confirm('确定删除？')){await api(t.dataset.path+'/'+encodeURIComponent(t.dataset.id),{method:'DELETE'});await loadAll();}}});};
if($('skillBulkSelectAll')){$('skillBulkSelectAll').onclick=function(){document.querySelectorAll('[data-bulk-grant-employee]').forEach(function(x){x.checked=true;});};$('skillBulkClear').onclick=function(){document.querySelectorAll('[data-bulk-grant-employee]').forEach(function(x){x.checked=false;});};$('skillBulkCancel').onclick=function(){bulkGrant={type:'',id:''};renderBulkGrant();};$('skillBulkSave').onclick=function(){run(async function(){var configs=bulkGrantConfig();var cfg=configs[bulkGrant.type];if(!cfg||!bulkGrant.id)throw new Error('请选择要分配的授权对象');var codes=Array.from(document.querySelectorAll('[data-bulk-grant-employee]:checked')).map(function(x){return x.getAttribute('data-bulk-grant-employee');}).filter(Boolean);await api(cfg.path+'/'+encodeURIComponent(bulkGrant.id)+'/employees',{method:'PATCH',body:JSON.stringify({activationCodes:codes})});await loadAll();alert(cfg.title+'分配已保存');});};}
document.body.addEventListener('click',function(e){var t=e.target;var a=t.dataset&&t.dataset.act;if(a!=='bulkGrant')return;e.preventDefault();e.stopPropagation();bulkGrant={type:t.dataset.type,id:t.dataset.id};renderBulkGrant();},true);
loadAll().catch(function(e){alert(e.message);});
</script></body></html>`;

const requireAdmin = (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (token !== ADMIN_TOKEN) {
    fail(res, 401, 'Unauthorized.');
    return false;
  }
  return true;
};

const deleteById = (items, itemId) => {
  const index = items.findIndex(item => item.id === itemId);
  if (index >= 0) items.splice(index, 1);
  return index >= 0;
};

const removeEmployeeGrant = (employees, grantKey, itemId) => {
  for (const employee of employees) {
    employee[grantKey] = list(employee[grantKey]).filter(id => id !== itemId);
  }
};

const assignEmployeeGrant = (employees, grantKey, itemId, activationCodes) => {
  const selectedCodes = new Set(list(activationCodes));
  let assigned = 0;
  for (const employee of employees) {
    const grants = new Set(list(employee[grantKey]));
    if (selectedCodes.has(employee.activationCode)) {
      grants.add(itemId);
      assigned += 1;
    } else {
      grants.delete(itemId);
    }
    employee[grantKey] = [...grants];
    employee.updatedAt = nowIso();
  }
  return assigned;
};

const normalizeRelease = (body, existing = {}) => ({
  version: String(body.version ?? existing.version ?? '').trim(),
  date: String(body.date ?? existing.date ?? '').trim(),
  notesZh: String(body.notesZh ?? existing.notesZh ?? '').trim(),
  notesEn: String(body.notesEn ?? existing.notesEn ?? '').trim(),
  windowsX64Url: String(body.windowsX64Url ?? existing.windowsX64Url ?? '').trim(),
  macArmUrl: String(body.macArmUrl ?? existing.macArmUrl ?? '').trim(),
  macIntelUrl: String(body.macIntelUrl ?? existing.macIntelUrl ?? '').trim(),
  manualUrl: String(body.manualUrl ?? existing.manualUrl ?? '').trim(),
  updatedAt: nowIso(),
});

const sendJsonDownload = (res, fileName, data) => {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${fileName}"`,
  });
  res.end(JSON.stringify(ensureData(data), null, 2));
};

const releaseResponse = (data, req) => {
  const release = data.release || {};
  const autoRelease = detectAutoRelease(requestOrigin(req)) || {};
  const notesZh = autoRelease.notesZh?.length ? autoRelease.notesZh : release.notesZh ? release.notesZh.split(/\r?\n/).filter(Boolean) : [];
  const notesEn = autoRelease.notesEn?.length ? autoRelease.notesEn : release.notesEn ? release.notesEn.split(/\r?\n/).filter(Boolean) : notesZh;
  const version = autoRelease.version || release.version || '';
  return {
    code: 0,
    data: {
      value: {
        version,
        date: autoRelease.date || release.date || String(release.updatedAt || nowIso()).slice(0, 10),
        changeLog: {
          ch: { title: version ? `LfClaw ${version}` : '', content: notesZh },
          en: { title: version ? `LfClaw ${version}` : '', content: notesEn },
        },
        windowsX64: {
          url: autoRelease.windowsX64Url || release.windowsX64Url || '',
          size: autoRelease.windowsX64Size,
          sha256: autoRelease.windowsX64Sha256,
        },
        macArm: {
          url: autoRelease.macArmUrl || release.macArmUrl || '',
          size: autoRelease.macArmSize,
          sha256: autoRelease.macArmSha256,
        },
        macIntel: {
          url: autoRelease.macIntelUrl || release.macIntelUrl || '',
          size: autoRelease.macIntelSize,
          sha256: autoRelease.macIntelSha256,
        },
      },
    },
  };
};

const handleAdmin = async (req, res, url, data) => {
  if (url.pathname === '/admin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(adminHtml());
    return true;
  }
  if (!url.pathname.startsWith('/api/admin/')) return false;
  if (!requireAdmin(req, res)) return true;
  if (url.pathname === '/api/admin/state' && req.method === 'GET') return ok(res, adminState(data)), true;
  if (url.pathname === '/api/admin/asr' && req.method === 'POST') {
    const body = await readBody(req);
    data.asr = normalizeAsr(body, data.asr);
    writeData(data);
    return ok(res, redactAsr(data.asr)), true;
  }
  if (url.pathname === '/api/admin/export' && req.method === 'GET') {
    sendJsonDownload(res, `enterprise-data-${backupTimestamp()}.json`, data);
    return true;
  }
  if (url.pathname === '/api/admin/backups' && req.method === 'GET') return ok(res, { backups: listBackups() }), true;
  if (url.pathname === '/api/admin/backups' && req.method === 'POST') return ok(res, { backup: createBackup(data), backups: listBackups() }), true;
  const backupMatch = url.pathname.match(/^\/api\/admin\/backups\/([^/]+)\/download$/);
  if (backupMatch && req.method === 'GET') {
    const name = decodeURIComponent(backupMatch[1]);
    if (!assertBackupName(name)) return fail(res, 400, 'Invalid backup name.'), true;
    const filePath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(filePath)) return fail(res, 404, 'Backup not found.'), true;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  if (url.pathname === '/api/admin/release' && req.method === 'POST') {
    const body = await readBody(req);
    data.release = normalizeRelease(body, data.release);
    writeData(data);
    return ok(res, data.release), true;
  }
  if (url.pathname === '/api/admin/pinyin' && req.method === 'GET') {
    const name = url.searchParams.get('name') || '';
    return ok(res, { pinyin: pinyinSlug(name), employeeId: makeEmployeeId(name), activationPrefix: `LFCLAW-${pinyinSlug(name).toUpperCase()}` }), true;
  }
  if (url.pathname === '/api/admin/model-providers/test' && req.method === 'POST') {
    const body = await readBody(req);
    const existing = data.modelProviders.find(item => item.id === body.id || item.id === body.modelId);
    const item = normalizeModel(body, existing);
    const model = item.models?.[0]?.id || item.id;
    const baseUrl = String(item.baseUrl || '').replace(/\/+$/, '');
    const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const requestHeaders = {
      authorization: `Bearer ${item.apiKey}`,
      'content-type': 'application/json',
    };
    const makePayload = useModernLimit => ({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      ...(useModernLimit
        ? { max_completion_tokens: MODEL_CONNECTION_TEST_TOKEN_BUDGET }
        : { max_tokens: MODEL_CONNECTION_TEST_TOKEN_BUDGET }),
    });
    const shouldRetryLegacyLimit = text => /max_completion_tokens|unsupported parameter|unknown parameter|unrecognized/i.test(text || '');
    try {
      let response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: requestHeaders,
        body: JSON.stringify(makePayload(true)),
      });
      let text = await response.text();
      if (!response.ok && response.status === 400 && shouldRetryLegacyLimit(text)) {
        response = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: requestHeaders,
          body: JSON.stringify(makePayload(false)),
        });
        text = await response.text();
      }
      if (isOutputLimitConnectivitySuccess(response.status, text)) {
        return ok(res, { ok: true, status: response.status, model }), true;
      }
      if (!response.ok) {
        return ok(res, {
          ok: false,
          status: response.status,
          message: text.slice(0, 300) || `HTTP ${response.status}`,
        }), true;
      }
      return ok(res, { ok: true, status: response.status, model }), true;
    } catch (error) {
      return ok(res, {
        ok: false,
        message: error?.name === 'AbortError' ? '连接超时' : String(error?.message || error),
      }), true;
    } finally {
      clearTimeout(timer);
    }
  }
  if (url.pathname === '/api/admin/model-providers' && req.method === 'POST') {
    const body = await readBody(req);
    const existing = data.modelProviders.find(item => item.id === body.id);
    const item = normalizeModel(body, existing);
    existing ? Object.assign(existing, item) : data.modelProviders.unshift(item);
    writeData(data);
    return ok(res, redactModel(item)), true;
  }
  if (url.pathname === '/api/admin/mcp' && req.method === 'POST') {
    const body = await readBody(req);
    const existing = data.mcpServers.find(item => item.id === body.id);
    const item = normalizeMcp(body, existing);
    existing ? Object.assign(existing, item) : data.mcpServers.unshift(item);
    writeData(data);
    return ok(res, item), true;
  }
  if (url.pathname === '/api/admin/skills/upload' && req.method === 'POST') {
    const { fields, files } = parseMultipart(await readRawBody(req), req.headers['content-type'] || '');
    const existing = data.skills.find(item => item.id === fields.id);
    let packageMeta = {};
    const file = files.package;
    if (file?.content?.length) {
      fs.mkdirSync(SKILL_DIR, { recursive: true });
      const skillId = String(fields.id || existing?.id || id('skill')).trim();
      const storedName = `${skillId}-${Date.now()}-${file.filename}`;
      const packagePath = path.join(SKILL_DIR, storedName);
      fs.writeFileSync(packagePath, file.content);
      packageMeta = {
        packageFileName: file.filename,
        packagePath,
        packageSize: file.content.length,
        packageSha256: crypto.createHash('sha256').update(file.content).digest('hex'),
      };
    }
    const item = normalizeSkill({ ...fields, ...packageMeta }, existing);
    if (!item.id) throw new Error('技能 ID 必填。');
    existing ? Object.assign(existing, item) : data.skills.unshift(item);
    writeData(data);
    return ok(res, { ...item, packagePath: undefined }), true;
  }
  if (url.pathname === '/api/admin/skills' && req.method === 'POST') {
    const body = await readBody(req);
    const existing = data.skills.find(item => item.id === body.id);
    const item = normalizeSkill(body, existing);
    if (!item.id) throw new Error('技能 ID 必填。');
    existing ? Object.assign(existing, item) : data.skills.unshift(item);
    writeData(data);
    return ok(res, { ...item, packagePath: undefined }), true;
  }
  for (const [route, collection, grantKey, resultKey] of [
    ['/api/admin/model-providers', data.modelProviders, 'allowedModelProviderIds', 'modelProviderId'],
    ['/api/admin/mcp', data.mcpServers, 'allowedMcpServerIds', 'mcpServerId'],
    ['/api/admin/skills', data.skills, 'allowedSkillIds', 'skillId'],
  ]) {
    const grantMatch = url.pathname.match(new RegExp(`^${route}/([^/]+)/employees$`));
    if (grantMatch && req.method === 'PATCH') {
      const itemId = decodeURIComponent(grantMatch[1]);
      if (!collection.some(item => item.id === itemId)) return fail(res, 404, '授权对象不存在。'), true;
      const body = await readBody(req);
      const assigned = assignEmployeeGrant(
        data.employees,
        grantKey,
        itemId,
        body.activationCodes ?? body.employeeActivationCodes ?? body.employeeCodes,
      );
      writeData(data);
      return ok(res, { [resultKey]: itemId, assigned, employees: data.employees.map(employeeView) }), true;
    }
  }
  for (const [route, collection, grantKey] of [
    ['/api/admin/model-providers', data.modelProviders, 'allowedModelProviderIds'],
    ['/api/admin/mcp', data.mcpServers, 'allowedMcpServerIds'],
    ['/api/admin/skills', data.skills, 'allowedSkillIds'],
  ]) {
    const match = url.pathname.match(new RegExp(`^${route}/([^/]+)$`));
    if (match && req.method === 'DELETE') {
      const itemId = decodeURIComponent(match[1]);
      if (route === '/api/admin/skills') {
        const existing = collection.find(item => item.id === itemId);
        if (existing?.packagePath && fs.existsSync(existing.packagePath)) {
          fs.rmSync(existing.packagePath, { force: true });
        }
      }
      deleteById(collection, itemId);
      removeEmployeeGrant(data.employees, grantKey, itemId);
      writeData(data);
      return ok(res, { deleted: true }), true;
    }
  }
  if (url.pathname === '/api/admin/employees' && req.method === 'POST') {
    const body = await readBody(req);
    const employeeName = String(body.employeeName || '').trim();
    if (!employeeName) return fail(res, 400, '员工姓名必填。'), true;
    let activationCode = makeActivationCode(employeeName);
    while (data.employees.some(employee => employee.activationCode === activationCode)) activationCode = makeActivationCode(employeeName);
    const employee = {
      id: id('employee'),
      activationCode,
      employeeName,
      employeeId: String(body.employeeId || '').trim() || makeEmployeeId(employeeName),
      status: 'active',
      deviceToken: null,
      lastUsedAt: null,
      lastActivatedAt: null,
      lastActivatedClientVersion: '',
      lastSeenClientVersion: '',
      lastSeenClientVersionAt: null,
      creditsLimit: toNumber(body.creditsLimit),
      creditsUsed: 0,
      allowedModelProviderIds: list(body.allowedModelProviderIds ?? body.allowedModelIds),
      allowedMcpServerIds: list(body.allowedMcpServerIds),
      allowedSkillIds: list(body.allowedSkillIds),
      notes: String(body.notes || ''),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data.employees.unshift(employee);
    writeData(data);
    return ok(res, employeeView(employee)), true;
  }
  const employeeMatch = url.pathname.match(/^\/api\/admin\/employees\/([^/]+)$/);
  if (employeeMatch && req.method === 'PATCH') {
    const employee = data.employees.find(item => item.activationCode === decodeURIComponent(employeeMatch[1]));
    if (!employee) return fail(res, 404, '员工不存在。'), true;
    const body = await readBody(req);
    if (body.status === 'active' || body.status === 'disabled') employee.status = body.status;
    if (body.employeeName !== undefined) employee.employeeName = String(body.employeeName || employee.employeeName).trim();
    if (body.employeeId !== undefined) employee.employeeId = String(body.employeeId || employee.employeeId).trim();
    if (body.creditsLimit !== undefined) employee.creditsLimit = toNumber(body.creditsLimit);
    if (body.creditsUsed !== undefined) employee.creditsUsed = toNumber(body.creditsUsed);
    if (body.allowedModelProviderIds !== undefined || body.allowedModelIds !== undefined) employee.allowedModelProviderIds = list(body.allowedModelProviderIds ?? body.allowedModelIds);
    if (body.allowedMcpServerIds !== undefined) employee.allowedMcpServerIds = list(body.allowedMcpServerIds);
    if (body.allowedSkillIds !== undefined) employee.allowedSkillIds = list(body.allowedSkillIds);
    if (body.notes !== undefined) employee.notes = String(body.notes || '');
    employee.updatedAt = nowIso();
    writeData(data);
    return ok(res, employeeView(employee)), true;
  }
  if (employeeMatch && req.method === 'DELETE') {
    data.employees = data.employees.filter(item => item.activationCode !== decodeURIComponent(employeeMatch[1]));
    writeData(data);
    return ok(res, { deleted: true }), true;
  }
  return false;
};

const findEmployeeByToken = (data, token) => {
  const session = data.sessions[token];
  if (!session) return null;
  return data.employees.find(employee => employee.activationCode === session.activationCode) || null;
};

const cleanupAsrProxySessions = () => {
  const expiresBefore = Date.now() - ASR_PROXY_SESSION_TTL_MS;
  for (const [requestId, session] of asrProxySessions) {
    if (!session || session.createdAt < expiresBefore) asrProxySessions.delete(requestId);
  }
};

const createDashScopeRunTask = (asr, taskId) => ({
  header: {
    action: 'run-task',
    task_id: taskId,
    streaming: 'duplex',
  },
  payload: {
    task_group: 'audio',
    task: 'asr',
    function: 'recognition',
    model: asr.model || 'fun-asr-realtime',
    parameters: {
      format: asr.format || 'wav',
      sample_rate: toNumber(asr.sampleRate, 16000),
    },
    input: {},
  },
});

const createDashScopeFinishTask = taskId => ({
  header: {
    action: 'finish-task',
    task_id: taskId,
    streaming: 'duplex',
  },
  payload: {
    input: {},
  },
});

const dashScopeTextFromMessage = message => {
  const sentence = message?.payload?.output?.sentence;
  if (typeof sentence?.text === 'string') return sentence.text;
  if (typeof message?.payload?.output?.text === 'string') return message.payload.output.text;
  if (Array.isArray(message?.payload?.output?.sentences)) {
    return message.payload.output.sentences.map(item => item?.text || '').join('');
  }
  return '';
};

const handleAsrProxyWebSocket = (client, req, url) => {
  cleanupAsrProxySessions();
  const requestId = decodeURIComponent(url.pathname.match(/^\/api\/enterprise\/asr\/realtime\/ws\/([^/]+)$/)?.[1] || '');
  const proxyToken = url.searchParams.get('token') || '';
  const session = asrProxySessions.get(requestId);
  if (!session || session.proxyToken !== proxyToken || Date.now() - session.createdAt > ASR_PROXY_SESSION_TTL_MS) {
    sendAsrError(client, requestId, 401, 'Enterprise ASR session expired.');
    closeWebSocket(client);
    return;
  }

  const data = readData();
  const employee = findEmployeeByToken(data, session.token);
  if (!employee || employee.status !== 'active') {
    sendAsrError(client, requestId, 403, 'Activation code is disabled.');
    closeWebSocket(client);
    return;
  }

  const asr = normalizeAsr(data.asr);
  const upstreamUrl = resolveAsrWsUrl(asr);
  if (!asr.apiKey || !upstreamUrl) {
    sendAsrError(client, requestId, 400, 'Enterprise ASR is not configured.');
    closeWebSocket(client);
    return;
  }

  const taskId = randomHex(16);
  const pendingAudio = [];
  let upstreamStarted = false;
  let upstreamClosed = false;
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `bearer ${asr.apiKey}`,
    },
  });

  const flushAudio = () => {
    if (!upstreamStarted || upstream.readyState !== WebSocket.OPEN) return;
    while (pendingAudio.length > 0) upstream.send(pendingAudio.shift());
  };

  const finishUpstream = () => {
    if (upstreamClosed || upstream.readyState !== WebSocket.OPEN) return;
    upstreamClosed = true;
    upstream.send(JSON.stringify(createDashScopeFinishTask(taskId)));
  };

  const cleanup = () => {
    asrProxySessions.delete(requestId);
  };

  upstream.on('open', () => {
    upstream.send(JSON.stringify(createDashScopeRunTask(asr, taskId)));
  });

  upstream.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    const event = message?.header?.event || message?.header?.action || '';
    if (event === 'task-started') {
      upstreamStarted = true;
      sendAsrEvent(client, { type: 'started', requestId });
      flushAudio();
      return;
    }
    if (event === 'result-generated') {
      const text = dashScopeTextFromMessage(message);
      if (!text) return;
      sendAsrEvent(client, {
        type: 'recognition',
        requestId,
        text,
        raw: {
          action: event,
          result: [{
            seg_id: toNumber(message?.payload?.output?.sentence?.begin_time, Date.now()),
            st: {
              sentence: text,
              partial: message?.payload?.output?.sentence?.sentence_end !== true,
            },
          }],
        },
      });
      return;
    }
    if (event === 'task-finished') {
      sendAsrEvent(client, { type: 'closed', requestId });
      closeWebSocket(client);
      closeWebSocket(upstream);
      cleanup();
      return;
    }
    if (event === 'task-failed') {
      sendAsrError(client, requestId, 50201, message?.header?.error_message || message?.header?.error_code || 'Enterprise ASR upstream failed.');
      closeWebSocket(client);
      closeWebSocket(upstream);
      cleanup();
    }
  });

  upstream.on('error', error => {
    console.warn('[ASR] enterprise upstream websocket failed:', error);
    sendAsrError(client, requestId, 50201, error?.message || 'Enterprise ASR upstream failed.');
    closeWebSocket(client);
    cleanup();
  });

  upstream.on('close', () => {
    if (client.readyState === WebSocket.OPEN) sendAsrEvent(client, { type: 'closed', requestId });
    cleanup();
  });

  client.on('message', (raw, isBinary) => {
    if (!isBinary) {
      const text = raw.toString('utf8');
      if (text.includes('"end"') || text.includes("'end'")) {
        finishUpstream();
      }
      return;
    }
    if (upstreamStarted && upstream.readyState === WebSocket.OPEN) {
      upstream.send(raw);
    } else {
      pendingAudio.push(raw);
    }
  });

  client.on('close', () => {
    finishUpstream();
    closeWebSocket(upstream);
    cleanup();
  });
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if ((req.method === 'GET' || req.method === 'HEAD') && serveReleaseFile(req, res, url.pathname)) return;
  const data = readData();
  try {
    if (await handleAdmin(req, res, url, data)) return;
    if ((url.pathname === '/api/enterprise/update' || url.pathname === '/api/enterprise/update-manual') && req.method === 'GET') {
      return json(res, 200, releaseResponse(data, req));
    }
    if (url.pathname === '/api/enterprise/activate' && req.method === 'POST') {
      const body = await readBody(req);
      const activationCode = String(body.activationCode || '').trim().toUpperCase();
      const clientVersion = clientVersionFromRequest(req, url, body);
      const employee = data.employees.find(item => item.activationCode === activationCode);
      if (!employee) return fail(res, 404, 'Activation code not found.');
      if (employee.status !== 'active') return fail(res, 403, 'Activation code is disabled.');
      employee.deviceToken = String(body.deviceToken || '');
      employee.deviceName = String(body.deviceName || '');
      employee.platform = String(body.platform || '');
      if (clientVersion) employee.clientVersion = clientVersion;
      const activatedAt = nowIso();
      employee.lastActivatedClientVersion = clientVersion;
      employee.lastActivatedAt = activatedAt;
      employee.lastSeenClientVersion = clientVersion;
      employee.lastSeenClientVersionAt = activatedAt;
      employee.lastUsedAt = activatedAt;
      employee.updatedAt = activatedAt;
      const accessToken = randomHex(24);
      data.sessions[accessToken] = { activationCode, createdAt: nowIso(), clientVersion };
      writeData(data);
      return ok(res, clientPayload(data, employee, accessToken, req, clientVersion));
    }
    if (url.pathname === '/api/enterprise/me' && req.method === 'GET') {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const employee = findEmployeeByToken(data, token);
      if (!employee) return fail(res, 401, 'Enterprise session is invalid.');
      if (employee.status !== 'active') return fail(res, 403, 'Activation code is disabled.');
      const session = data.sessions?.[token];
      const clientVersion = clientVersionFromRequest(req, url) || normalizeClientVersion(session?.clientVersion || employee.clientVersion);
      if (clientVersion) {
        const seenAt = nowIso();
        employee.clientVersion = clientVersion;
        employee.lastSeenClientVersion = clientVersion;
        employee.lastSeenClientVersionAt = seenAt;
        if (session) session.clientVersion = clientVersion;
        employee.lastUsedAt = seenAt;
        employee.updatedAt = seenAt;
        writeData(data);
      }
      return ok(res, clientPayload(data, employee, token, req, clientVersion));
    }
    if (url.pathname === '/api/enterprise/asr/realtime/sessions' && req.method === 'POST') {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const employee = findEmployeeByToken(data, token);
      if (!employee) return fail(res, 401, 'Enterprise session is invalid.');
      if (employee.status !== 'active') return fail(res, 403, 'Activation code is disabled.');
      const asr = normalizeAsr(data.asr);
      const upstreamUrl = resolveAsrWsUrl(asr);
      if (!asr.apiKey || !upstreamUrl) return fail(res, 400, 'Enterprise ASR is not configured.');
      const requestId = id('asr');
      const proxyToken = randomHex(16);
      asrProxySessions.set(requestId, { token, proxyToken, createdAt: Date.now() });
      const origin = requestOrigin(req).replace(/\/+$/, '');
      const wsOrigin = origin.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
      return ok(res, {
        requestId,
        wsUrl: `${wsOrigin}/api/enterprise/asr/realtime/ws/${encodeURIComponent(requestId)}?token=${encodeURIComponent(proxyToken)}`,
        expiresInSeconds: Math.floor(ASR_PROXY_SESSION_TTL_MS / 1000),
        chunkIntervalMillis: toNumber(asr.chunkIntervalMillis, 200),
        maxSessionSeconds: toNumber(asr.maxSessionSeconds, 60),
        audioFormat: asr.format || 'wav',
        format: asr.format || 'wav',
        maxConcurrentSessions: 1,
        usedSecondsToday: 0,
        remainingSecondsToday: 86400,
        limitSecondsToday: 86400,
      });
    }
    const skillMatch = url.pathname.match(/^\/api\/enterprise\/skills\/([^/]+)\/download$/);
    if (skillMatch && req.method === 'GET') {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const employee = findEmployeeByToken(data, token);
      if (!employee) return fail(res, 401, 'Enterprise session is invalid.');
      if (employee.status !== 'active') return fail(res, 403, 'Activation code is disabled.');
      const skillId = decodeURIComponent(skillMatch[1]);
      if (!list(employee.allowedSkillIds).includes(skillId)) return fail(res, 403, 'Skill is not allowed.');
      const skill = data.skills.find(item => item.id === skillId);
      if (!skill?.packagePath || !fs.existsSync(skill.packagePath)) return fail(res, 404, 'Skill package not found.');
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${encodeURIComponent(skill.packageFileName || `${skill.id}.zip`)}"` });
      fs.createReadStream(skill.packagePath).pipe(res);
      return;
    }
    if (url.pathname === '/api/enterprise/usage' && req.method === 'POST') {
      const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      const employee = findEmployeeByToken(data, token);
      if (!employee) return fail(res, 401, 'Enterprise session is invalid.');
      if (employee.status !== 'active') return fail(res, 403, 'Activation code is disabled.');
      const body = await readBody(req);
      const modelId = String(body.modelId || 'unknown');
      const provider = data.modelProviders.find(item => item.models?.some(model => model.id === modelId));
      const credits = body.credits === undefined ? calculateUsageCredits(provider, body) : toNumber(body.credits);
      const creditsRemaining = Math.max(0, toNumber(employee.creditsLimit) - toNumber(employee.creditsUsed));
      if (creditsRemaining <= 0) {
        return fail(res, 402, 'Enterprise credits exhausted.');
      }
      const chargedCredits = Number(Math.min(credits, creditsRemaining).toFixed(4));
      const event = {
        id: id('usage'),
        employeeId: employee.employeeId,
        modelId,
        credits: chargedCredits,
        calculatedCredits: Number(credits.toFixed(4)),
        exhaustedByCall: credits > creditsRemaining,
        inputTokens: toNumber(body.inputTokens),
        outputTokens: toNumber(body.outputTokens),
        cacheWriteTokens: toNumber(body.cacheWriteTokens),
        cacheReadTokens: toNumber(body.cacheReadTokens),
        currency: provider?.billing?.currency || '',
        priceSourceUrl: provider?.billing?.sourceUrl || '',
        createdAt: nowIso(),
      };
      data.usageEvents.push(event);
      employee.creditsUsed = Number((toNumber(employee.creditsUsed) + chargedCredits).toFixed(4));
      employee.lastUsedAt = nowIso();
      writeData(data);
      return ok(res, { credits: chargedCredits, calculatedCredits: event.calculatedCredits, event });
    }
    fail(res, 404, 'Not found.');
  } catch (error) {
    fail(res, 500, error instanceof Error ? error.message : String(error));
  }
});

const asrWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (!/^\/api\/enterprise\/asr\/realtime\/ws\/[^/]+$/.test(url.pathname)) {
      socket.destroy();
      return;
    }
    asrWss.handleUpgrade(req, socket, head, client => {
      handleAsrProxyWebSocket(client, req, url);
    });
  } catch {
    socket.destroy();
  }
});

fs.mkdirSync(SKILL_DIR, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(`[LfClaw Enterprise] listening at http://${HOST}:${PORT}`);
});



