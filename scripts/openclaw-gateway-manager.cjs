#!/usr/bin/env node
'use strict';

/**
 * Lightweight multi-user OpenClaw Gateway manager.
 *
 * Public surface:
 *   GET /health
 *   POST /api/enterprise/activate
 *   GET /api/enterprise/files/download
 *   GET /api/enterprise/releases/latest
 *   GET /api/enterprise/releases/download
 *   GET /api/openclaw/gateway-token
 *   GET /api/admin/activation-codes
 *   POST /api/admin/activation-codes
 *   POST /api/admin/activation-codes/disable
 *   POST /api/admin/activation-codes/enable
 *   POST /api/admin/activation-codes/delete
 *   GET /admin
 *   WS  /gateway/:leaseId
 *
 * It keeps OpenClaw instances bound to 127.0.0.1 only. Clients connect to this
 * manager, and the manager proxies WebSocket traffic to the right per-user
 * OpenClaw gateway.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = {
  host: process.env.LOBSTERAI_GATEWAY_MANAGER_HOST || '0.0.0.0',
  port: Number(process.env.LOBSTERAI_GATEWAY_MANAGER_PORT || 18791),
  publicBaseUrl: (process.env.LOBSTERAI_GATEWAY_MANAGER_PUBLIC_BASE_URL || 'http://8.216.38.213:18791').replace(/\/+$/, ''),
  serverBaseUrl: (process.env.LOBSTERAI_SERVER_BASE_URL || 'https://lobsterai-server.youdao.com').replace(/\/+$/, ''),
  openclawBin: process.env.OPENCLAW_BIN || 'openclaw',
  dataRoot: process.env.LOBSTERAI_GATEWAY_MANAGER_DATA_ROOT || '/opt/lobsterai-gateway-manager',
  activationStorePath: process.env.LOBSTERAI_GATEWAY_MANAGER_ACTIVATION_STORE || '',
  releasesRoot: process.env.LFCLAW_RELEASES_ROOT || path.join(process.env.LOBSTERAI_GATEWAY_MANAGER_DATA_ROOT || '/opt/lobsterai-gateway-manager', 'releases'),
  templateConfigPath: process.env.LOBSTERAI_OPENCLAW_TEMPLATE_CONFIG || path.join(os.homedir(), '.openclaw', 'openclaw.json'),
  templateAuthStorePath: process.env.LOBSTERAI_OPENCLAW_TEMPLATE_AUTH_STORE || path.join(os.homedir(), '.openclaw', 'agents', 'main', 'agent', 'openclaw-agent.sqlite'),
  model: process.env.LOBSTERAI_OPENCLAW_MODEL || 'zai/glm-5.2',
  portStart: Number(process.env.LOBSTERAI_OPENCLAW_PORT_START || 19001),
  portEnd: Number(process.env.LOBSTERAI_OPENCLAW_PORT_END || 19999),
  idleMs: Number(process.env.LOBSTERAI_OPENCLAW_IDLE_MS || 30 * 60 * 1000),
  startupTimeoutMs: Number(process.env.LOBSTERAI_OPENCLAW_STARTUP_TIMEOUT_MS || 60 * 1000),
};

const users = new Map();
const leases = new Map();

function getActivationStorePath() {
  return config.activationStorePath || path.join(config.dataRoot, 'activation-codes.json');
}

function log(...args) {
  console.log(new Date().toISOString(), '[gateway-manager]', ...args);
}

function safeUserKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 24);
}

function safePathSegment(raw) {
  const normalized = String(raw || '')
    .trim()
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return normalized || safeUserKey(raw);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonIfMissing(filePath, value) {
  if (fs.existsSync(filePath)) return;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    log(`failed to read json ${filePath}: ${error.message || error}`);
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function ensureActivationStore() {
  const filePath = getActivationStorePath();
  if (fs.existsSync(filePath)) return;
  writeJsonIfMissing(filePath, {
    codes: {
      'LOB-EXAMPLE-CHANGE-ME': {
        enabled: false,
        userId: 'u_10001',
        displayName: '示例用户',
        folderName: 'u_10001_example',
      },
    },
    tokens: {},
  });
  log(`created activation store template: ${filePath}`);
}

function readActivationStore() {
  ensureActivationStore();
  const store = readJsonIfExists(getActivationStorePath(), { codes: {}, tokens: {} });
  return {
    codes: store && typeof store.codes === 'object' && !Array.isArray(store.codes) ? store.codes : {},
    tokens: store && typeof store.tokens === 'object' && !Array.isArray(store.tokens) ? store.tokens : {},
  };
}

function saveActivationStore(store) {
  writeJsonAtomic(getActivationStorePath(), store);
}

function hashActivationToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function findActivationCodeByHash(store, codeHash) {
  if (!codeHash) return undefined;
  for (const code of Object.keys(store.codes || {})) {
    if (crypto.createHash('sha256').update(code).digest('hex') === codeHash) {
      return code;
    }
  }
  return undefined;
}

function hashActivationCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function normalizeDisplayName(name) {
  return String(name || '').trim().replace(/\s+/g, '').toLowerCase();
}

const PINYIN_OVERRIDES = {
  张: 'zhang', 王: 'wang', 李: 'li', 赵: 'zhao', 刘: 'liu', 陈: 'chen', 杨: 'yang', 黄: 'huang',
  周: 'zhou', 吴: 'wu', 徐: 'xu', 孙: 'sun', 胡: 'hu', 朱: 'zhu', 高: 'gao', 林: 'lin',
  何: 'he', 郭: 'guo', 马: 'ma', 罗: 'luo', 梁: 'liang', 宋: 'song', 郑: 'zheng', 谢: 'xie',
  韩: 'han', 唐: 'tang', 冯: 'feng', 于: 'yu', 董: 'dong', 萧: 'xiao', 程: 'cheng', 曹: 'cao',
  袁: 'yuan', 邓: 'deng', 许: 'xu', 傅: 'fu', 沈: 'shen', 曾: 'zeng', 彭: 'peng', 吕: 'lv',
  苏: 'su', 卢: 'lu', 蒋: 'jiang', 蔡: 'cai', 贾: 'jia', 丁: 'ding', 魏: 'wei', 薛: 'xue',
  叶: 'ye', 阎: 'yan', 余: 'yu', 潘: 'pan', 杜: 'du', 戴: 'dai', 夏: 'xia', 钟: 'zhong',
  汪: 'wang', 田: 'tian', 任: 'ren', 姜: 'jiang', 范: 'fan', 方: 'fang', 石: 'shi', 姚: 'yao',
  谭: 'tan', 廖: 'liao', 邹: 'zou', 熊: 'xiong', 金: 'jin', 陆: 'lu', 郝: 'hao', 孔: 'kong',
  白: 'bai', 崔: 'cui', 康: 'kang', 毛: 'mao', 邱: 'qiu', 秦: 'qin', 江: 'jiang', 史: 'shi',
  顾: 'gu', 侯: 'hou', 邵: 'shao', 孟: 'meng', 龙: 'long', 万: 'wan', 段: 'duan', 雷: 'lei',
  钱: 'qian', 汤: 'tang', 尹: 'yin', 黎: 'li', 易: 'yi', 常: 'chang', 武: 'wu', 乔: 'qiao',
  佟: 'tong',
  三: 'san', 四: 'si', 五: 'wu', 六: 'liu', 七: 'qi', 八: 'ba', 九: 'jiu', 十: 'shi',
  一: 'yi', 二: 'er', 子: 'zi', 文: 'wen', 明: 'ming', 华: 'hua', 强: 'qiang', 伟: 'wei',
  芳: 'fang', 娜: 'na', 敏: 'min', 静: 'jing', 丽: 'li', 洋: 'yang', 磊: 'lei', 军: 'jun',
  艳: 'yan', 勇: 'yong', 杰: 'jie', 娟: 'juan', 涛: 'tao', 超: 'chao', 秀: 'xiu', 霞: 'xia',
  平: 'ping', 刚: 'gang', 桂: 'gui', 英: 'ying', 凯: 'kai', 亮: 'liang', 欣: 'xin', 佳: 'jia',
  宇: 'yu', 俊: 'jun', 博: 'bo', 轩: 'xuan', 浩: 'hao', 然: 'ran', 诚: 'cheng', 宁: 'ning',
  雪: 'xue', 莉: 'li', 丹: 'dan', 婷: 'ting', 慧: 'hui', 莹: 'ying', 琳: 'lin', 鑫: 'xin',
  岩: 'yan', 鹏: 'peng', 峰: 'feng', 飞: 'fei', 龙: 'long', 斌: 'bin', 兵: 'bing', 波: 'bo',
  东: 'dong', 南: 'nan', 西: 'xi', 北: 'bei', 中: 'zhong', 国: 'guo', 庆: 'qing', 庭: 'ting',
  昊: 'hao', 恒: 'heng', 衡: 'heng', 辉: 'hui', 晖: 'hui', 辰: 'chen', 晨: 'chen', 旭: 'xu',
  祥: 'xiang', 翔: 'xiang', 瑞: 'rui', 锐: 'rui', 睿: 'rui', 喆: 'zhe', 哲: 'zhe', 泽: 'ze',
  森: 'sen', 淼: 'miao', 媛: 'yuan', 圆: 'yuan', 源: 'yuan', 远: 'yuan', 媚: 'mei', 梅: 'mei',
  兰: 'lan', 莲: 'lian', 玲: 'ling', 灵: 'ling', 倩: 'qian', 茜: 'qian', 雯: 'wen', 燕: 'yan',
  瑶: 'yao', 怡: 'yi', 依: 'yi', 颖: 'ying', 影: 'ying', 露: 'lu', 璐: 'lu', 琪: 'qi',
  奇: 'qi', 琦: 'qi', 祺: 'qi', 伦: 'lun', 建: 'jian', 健: 'jian', 剑: 'jian', 立: 'li',
  志: 'zhi', 治: 'zhi', 智: 'zhi', 安: 'an', 新: 'xin', 清: 'qing', 青: 'qing', 秋: 'qiu',
  春: 'chun', 元: 'yuan', 可: 'ke', 乐: 'le', 嘉: 'jia', 家: 'jia', 成: 'cheng', 正: 'zheng',
};

function nameToSlug(displayName) {
  const raw = String(displayName || '').trim();
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '')
    .toLowerCase();
  if (ascii) return ascii.slice(0, 24);

  const parts = [];
  for (const char of raw) {
    if (PINYIN_OVERRIDES[char]) {
      parts.push(PINYIN_OVERRIDES[char]);
    } else if (/[\u4e00-\u9fff]/u.test(char)) {
      throw Object.assign(new Error(`姓名里有暂不支持自动转拼音的字：${char}`), { statusCode: 400 });
    }
  }
  return (parts.join('') || safeUserKey(raw)).slice(0, 24).toLowerCase();
}

function createActivationCode(nameSlug = '') {
  const part = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  const namePart = safePathSegment(nameSlug).replace(/_/g, '').toUpperCase().slice(0, 18);
  return namePart ? `LFCLAW-${namePart}-${part()}` : `LFCLAW-${part()}-${part()}-${part()}`;
}

function createActivationIdentity(displayName, store) {
  const nameSlug = nameToSlug(displayName);
  let suffix = randomToken(2);
  let userId = `u_${nameSlug}_${suffix}`;
  const existingUserIds = new Set(Object.values(store.codes || {}).map(record => String(record.userId || '')));
  while (existingUserIds.has(userId)) {
    suffix = randomToken(2);
    userId = `u_${nameSlug}_${suffix}`;
  }
  return {
    nameSlug,
    userId,
    folderName: safePathSegment(`${userId}_${nameSlug}`),
  };
}

function publicActivationRecord(code, record, store) {
  const codeHash = hashActivationCode(code);
  const tokens = Object.values(store.tokens || {}).filter(token => token.activationCodeHash === codeHash);
  const activeTokens = tokens.filter(token => token.enabled !== false).length;
  const lastTokenUsedAt = tokens
    .map(token => token.lastUsedAt)
    .filter(Boolean)
    .sort()
    .pop();
  return {
    activationCode: code,
    enabled: record.enabled !== false,
    userId: String(record.userId || ''),
    displayName: String(record.displayName || ''),
    folderName: String(record.folderName || ''),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActivatedAt: record.lastActivatedAt,
    lastDeviceName: record.lastDeviceName,
    activeTokens,
    tokenCount: tokens.length,
    lastTokenUsedAt,
  };
}

function resolveEnterpriseUserFromBearer(bearerToken) {
  if (!bearerToken) return null;
  const store = readActivationStore();
  const tokenHash = hashActivationToken(bearerToken);
  const tokenEntry = store.tokens[tokenHash];
  if (!tokenEntry || tokenEntry.enabled === false) return null;
  tokenEntry.lastUsedAt = new Date().toISOString();
  saveActivationStore(store);
  return {
    id: String(tokenEntry.userId),
    displayName: String(tokenEntry.displayName || tokenEntry.userId),
    folderName: safePathSegment(tokenEntry.folderName || `${tokenEntry.userId}_${tokenEntry.displayName || ''}`),
    activationCode: findActivationCodeByHash(store, tokenEntry.activationCodeHash),
  };
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function copyTemplateConfigIfMissing(targetPath) {
  if (fs.existsSync(targetPath)) return;
  ensureDir(path.dirname(targetPath));
  if (fs.existsSync(config.templateConfigPath)) {
    fs.copyFileSync(config.templateConfigPath, targetPath);
    return;
  }
  writeJsonIfMissing(targetPath, {
    gateway: { mode: 'local', bind: 'loopback' },
    agents: { defaults: { model: { primary: config.model } } },
  });
}

function enforceUserConfigIsolation(configPath, paths) {
  const openclawConfig = readJsonIfExists(configPath, {});
  const workspaceDir = path.join(paths.stateDir, 'workspace-main');
  ensureDir(workspaceDir);
  const nextConfig = {
    ...openclawConfig,
    agents: {
      ...(openclawConfig.agents && typeof openclawConfig.agents === 'object' ? openclawConfig.agents : {}),
      defaults: {
        ...(openclawConfig.agents?.defaults && typeof openclawConfig.agents.defaults === 'object'
          ? openclawConfig.agents.defaults
          : {}),
        workspace: workspaceDir,
        model: {
          ...(openclawConfig.agents?.defaults?.model && typeof openclawConfig.agents.defaults.model === 'object'
            ? openclawConfig.agents.defaults.model
            : {}),
          primary: config.model,
        },
      },
    },
  };
  writeJsonAtomic(configPath, nextConfig);
}

function copyFileIfExistsAndMissing(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) return false;
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function copyTemplateAuthStoreIfMissing(stateDir) {
  const targetPath = path.join(stateDir, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
  const copied = copyFileIfExistsAndMissing(config.templateAuthStorePath, targetPath);
  for (const suffix of ['-wal', '-shm']) {
    copyFileIfExistsAndMissing(`${config.templateAuthStorePath}${suffix}`, `${targetPath}${suffix}`);
  }
  if (!copied && !fs.existsSync(targetPath)) {
    log(`template auth store missing; user gateway may need provider keys: ${config.templateAuthStorePath}`);
  }
}

function isPortReachable(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function waitForPort(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isPortReachable(port, 600)) return true;
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  return false;
}

async function allocatePort() {
  const used = new Set([...users.values()].map(user => user.port));
  for (let port = config.portStart; port <= config.portEnd; port += 1) {
    if (used.has(port)) continue;
    if (!(await isPortReachable(port, 150))) return port;
  }
  throw new Error(`No free OpenClaw ports in ${config.portStart}-${config.portEnd}`);
}

async function resolveUserFromBearer(bearerToken) {
  if (!bearerToken) throw Object.assign(new Error('Missing bearer token'), { statusCode: 401 });
  const enterpriseUser = resolveEnterpriseUserFromBearer(bearerToken);
  if (enterpriseUser) return enterpriseUser;

  const resp = await fetch(`${config.serverBaseUrl}/api/user/profile`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
    },
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`Auth profile request failed: HTTP ${resp.status}`), { statusCode: 401 });
  }
  const body = await resp.json();
  const data = body && typeof body === 'object' ? body.data : null;
  const userId = data?.yid || data?.userId || data?.id || data?.email || data?.nickname;
  if (!userId) {
    throw Object.assign(new Error('Auth profile did not include a user id'), { statusCode: 401 });
  }
  return {
    id: String(userId),
    displayName: String(data?.nickname || data?.email || userId),
  };
}

function getUserPaths(userKey) {
  const root = path.join(config.dataRoot, 'users', userKey);
  return {
    root,
    homeDir: path.join(root, 'home'),
    stateDir: path.join(root, 'state'),
    configPath: path.join(root, 'state', 'openclaw.json'),
    logPath: path.join(root, 'gateway.log'),
    infoPath: path.join(root, 'user-info.json'),
  };
}

function isPathInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRemoteFilePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep original value
  }
  decoded = decoded.replace(/^file:\/\//i, '');
  if (/^\\root\\/.test(decoded)) {
    decoded = `/${decoded.replace(/^\\+/, '').replace(/\\/g, '/')}`;
  }
  return decoded;
}

function resolveAllowedDownloadPath(user, rawPath) {
  const normalized = normalizeRemoteFilePath(rawPath);
  if (!normalized) {
    throw Object.assign(new Error('Missing file path'), { statusCode: 400 });
  }
  const userKey = safePathSegment(user.folderName || user.id || safeUserKey(user.id));
  const paths = getUserPaths(userKey);
  const allowedRoots = [
    paths.root,
    paths.homeDir,
    paths.stateDir,
    path.join(paths.stateDir, 'workspace-main'),
    path.join(paths.homeDir, '.openclaw', 'workspace'),
    path.join(os.homedir(), '.openclaw', 'workspace'),
  ].map(root => path.resolve(root));

  const candidates = path.isAbsolute(normalized)
    ? [path.resolve(normalized)]
    : [
        path.resolve(path.join(paths.stateDir, 'workspace-main', normalized)),
        path.resolve(path.join(paths.homeDir, '.openclaw', 'workspace', normalized)),
        path.resolve(path.join(paths.root, normalized)),
        path.resolve(path.join(os.homedir(), '.openclaw', 'workspace', normalized)),
      ];
  const resolved = candidates.find(candidate => (
    allowedRoots.some(root => isPathInside(candidate, root))
    && fs.existsSync(candidate)
  )) || candidates[0];

  if (!allowedRoots.some(root => isPathInside(resolved, root))) {
    throw Object.assign(new Error('File path is outside allowed workspace'), { statusCode: 403 });
  }
  return resolved;
}

function resolveReleaseFilePath(rawPath) {
  const normalized = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw Object.assign(new Error('Missing or invalid release file path'), { statusCode: 400 });
  }
  const releasesRoot = path.resolve(config.releasesRoot);
  const resolved = path.resolve(path.join(releasesRoot, normalized));
  if (!isPathInside(resolved, releasesRoot)) {
    throw Object.assign(new Error('Release file path is outside releases root'), { statusCode: 403 });
  }
  return resolved;
}

function upsertUserInfo(input) {
  const userKey = safePathSegment(input.folderName || input.userId || safeUserKey(input.userId));
  const paths = getUserPaths(userKey);
  const previous = readJsonIfExists(paths.infoPath, {});
  const now = new Date().toISOString();
  ensureDir(paths.root);
  writeJsonAtomic(paths.infoPath, {
    ...previous,
    userKey,
    userId: String(input.userId || previous.userId || ''),
    displayName: String(input.displayName || previous.displayName || ''),
    folderName: userKey,
    activationCode: input.activationCode || previous.activationCode,
    activationEnabled: input.activationEnabled === undefined
      ? previous.activationEnabled
      : input.activationEnabled !== false,
    status: input.status || previous.status || 'created',
    deviceId: input.deviceId || previous.deviceId,
    deviceName: input.deviceName || previous.deviceName,
    appVersion: input.appVersion || previous.appVersion,
    port: input.port || previous.port,
    lastActivatedAt: input.lastActivatedAt || previous.lastActivatedAt,
    lastGatewayStartedAt: input.lastGatewayStartedAt || previous.lastGatewayStartedAt,
    createdAt: previous.createdAt || now,
    updatedAt: now,
  });
}

function syncActivationCodeUserInfo() {
  const store = readActivationStore();
  let count = 0;
  for (const [activationCode, record] of Object.entries(store.codes || {})) {
    if (!record) continue;
    upsertUserInfo({
      userId: record.userId,
      displayName: record.displayName,
      folderName: record.folderName,
      activationCode,
      activationEnabled: record.enabled !== false,
      status: record.enabled === false ? 'disabled' : 'created',
      deviceName: record.lastDeviceName,
      lastActivatedAt: record.lastActivatedAt,
    });
    count += 1;
  }
  if (count > 0) log(`synced ${count} activation user info file(s)`);
}

async function ensureUserGateway(user) {
  const userKey = safePathSegment(user.folderName || user.id || safeUserKey(user.id));
  let entry = users.get(userKey);
  if (entry?.process && !entry.process.killed && await isPortReachable(entry.port, 500)) {
    entry.lastUsedAt = Date.now();
    return entry;
  }

  const paths = getUserPaths(userKey);
  ensureDir(paths.root);
  ensureDir(paths.homeDir);
  ensureDir(paths.stateDir);
  copyTemplateConfigIfMissing(paths.configPath);
  enforceUserConfigIsolation(paths.configPath, paths);
  copyTemplateAuthStoreIfMissing(paths.stateDir);

  const port = entry?.port || await allocatePort();
  const token = entry?.token || randomToken();
  const logStream = fs.createWriteStream(paths.logPath, { flags: 'a' });
  const env = {
    ...process.env,
    HOME: paths.homeDir,
    OPENCLAW_HOME: paths.homeDir,
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configPath,
    OPENCLAW_GATEWAY_TOKEN: token,
  };
  const args = ['gateway', 'run', '--allow-unconfigured', '--bind', 'loopback', '--port', String(port), '--token', token, '--verbose'];
  const child = spawn(config.openclawBin, args, {
    cwd: paths.root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  child.once('exit', (code, signal) => {
    log(`OpenClaw exited user=${userKey} port=${port} code=${code} signal=${signal}`);
  });

  entry = {
    userKey,
    userId: user.id,
    displayName: user.displayName,
    port,
    token,
    process: child,
    paths,
    lastUsedAt: Date.now(),
  };
  users.set(userKey, entry);
  upsertUserInfo({
    userId: user.id,
    displayName: user.displayName,
    folderName: userKey,
    status: 'gateway-running',
    port,
    lastGatewayStartedAt: new Date().toISOString(),
  });

  log(`Starting OpenClaw user=${userKey} port=${port}`);
  const ready = await waitForPort(port, config.startupTimeoutMs);
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`OpenClaw did not become reachable on 127.0.0.1:${port}`);
  }
  return entry;
}

function createLease(entry) {
  const leaseId = randomToken(18);
  const expiresAt = Date.now() + Math.max(config.idleMs, 5 * 60 * 1000);
  leases.set(leaseId, {
    leaseId,
    userKey: entry.userKey,
    port: entry.port,
    token: entry.token,
    expiresAt,
  });
  return leases.get(leaseId);
}

function collectUserKeysForActivation(store, activationCode, record) {
  const codeHash = hashActivationCode(activationCode);
  const userKeys = new Set();
  if (record?.folderName) userKeys.add(safePathSegment(record.folderName));

  for (const tokenEntry of Object.values(store.tokens || {})) {
    if (tokenEntry?.activationCodeHash !== codeHash) continue;
    if (tokenEntry.folderName) {
      userKeys.add(safePathSegment(tokenEntry.folderName));
      continue;
    }
    if (tokenEntry.userId) {
      userKeys.add(safePathSegment(`${tokenEntry.userId}_${tokenEntry.displayName || ''}`));
    }
  }

  return userKeys;
}

function stopUserGateway(entry, reason) {
  if (!entry?.process || entry.process.killed) return false;
  log(`Stopping OpenClaw user=${entry.userKey} port=${entry.port} reason=${reason}`);
  try {
    entry.process.kill('SIGTERM');
  } catch (error) {
    log(`Failed to stop OpenClaw user=${entry.userKey}: ${error.message || error}`);
    return false;
  }
  const forceKill = setTimeout(() => {
    if (entry.process.exitCode === null && entry.process.signalCode === null) {
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // Process may have exited between the status check and kill call.
      }
    }
  }, 3_000);
  forceKill.unref?.();
  return true;
}

function invalidateRuntimeForActivation(store, activationCode, record, reason) {
  const userKeys = collectUserKeysForActivation(store, activationCode, record);
  let removedLeases = 0;
  let stoppedUsers = 0;

  for (const [leaseId, lease] of leases.entries()) {
    if (!userKeys.has(lease.userKey)) continue;
    leases.delete(leaseId);
    removedLeases += 1;
  }

  for (const userKey of userKeys) {
    const entry = users.get(userKey);
    if (!entry) continue;
    if (stopUserGateway(entry, reason)) stoppedUsers += 1;
    users.delete(userKey);
  }

  return {
    userKeys: [...userKeys],
    removedLeases,
    stoppedUsers,
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function getAdminHtml() {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LfClaw 激活码管理</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f6f8;
      color: #172033;
    }
    body { margin: 0; }
    main { width: min(1120px, calc(100vw - 32px)); margin: 32px auto 48px; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-end; margin-bottom: 24px; }
    h1 { font-size: 28px; margin: 0 0 8px; letter-spacing: 0; }
    p { margin: 0; color: #657083; line-height: 1.6; }
    section, .panel {
      background: #fff;
      border: 1px solid #dfe5ee;
      border-radius: 8px;
      box-shadow: 0 10px 28px rgba(23, 32, 51, 0.06);
    }
    section { padding: 20px; margin-bottom: 16px; }
    .grid { display: grid; grid-template-columns: minmax(240px, 420px); gap: 12px; }
    label { display: grid; gap: 6px; font-size: 13px; color: #465163; font-weight: 600; }
    input {
      height: 38px;
      border: 1px solid #cad3df;
      border-radius: 6px;
      padding: 0 11px;
      font-size: 14px;
      color: #172033;
      background: #fff;
      outline: none;
    }
    input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.13); }
    .actions { display: flex; gap: 10px; align-items: center; margin-top: 16px; flex-wrap: wrap; }
    button {
      border: 0;
      border-radius: 6px;
      height: 38px;
      padding: 0 14px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      background: #172033;
      color: #fff;
    }
    button.secondary { background: #e9eef5; color: #172033; }
    button.danger { background: #dc2626; }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .status { min-height: 22px; color: #2563eb; font-size: 13px; }
    .error { color: #dc2626; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5ebf2; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #465163; background: #f8fafc; font-size: 12px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .pill { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    .ok { background: #dcfce7; color: #166534; }
    .off { background: #fee2e2; color: #991b1b; }
    .table-wrap { overflow-x: auto; }
    @media (max-width: 860px) {
      header { display: block; }
      .grid { grid-template-columns: 1fr; }
      main { margin-top: 18px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>LfClaw 激活码管理</h1>
        <p>创建员工激活码、查看使用情况、禁用失效账号。</p>
      </div>
      <button class="secondary" id="reloadBtn">刷新列表</button>
    </header>

    <section>
      <div class="grid">
        <label>员工姓名
          <input id="displayName" placeholder="张三" />
        </label>
      </div>
      <div class="actions">
        <button id="createBtn">生成激活码</button>
        <span class="status" id="status"></span>
      </div>
    </section>

    <section>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>状态</th>
              <th>激活码</th>
              <th>员工</th>
              <th>目录</th>
              <th>设备 / Token</th>
              <th>最近使用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="tbody">
            <tr><td colspan="7">正在加载...</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const state = { codes: [] };
    const status = (msg, isError = false) => {
      $('status').textContent = msg || '';
      $('status').className = isError ? 'status error' : 'status';
    };
    const headers = () => ({ 'Content-Type': 'application/json' });
    const request = async (url, options = {}) => {
      const resp = await fetch(url, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok || body.code) throw new Error(body.message || '请求失败');
      return body.data;
    };
    const copy = async (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        status('已复制激活码');
        return;
      }
      const input = document.createElement('input');
      input.value = text;
      input.style.position = 'fixed';
      input.style.left = '-1000px';
      document.body.appendChild(input);
      input.focus();
      input.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(input);
      status(ok ? '已复制激活码' : '已生成，请在列表中手动复制');
    };
    const render = () => {
      const rows = state.codes.map((item) => {
        const employee = [item.userId, item.displayName].filter(Boolean).join(' / ');
        return '<tr>'
          + '<td><span class="pill ' + (item.enabled ? 'ok' : 'off') + '">' + (item.enabled ? '启用' : '禁用') + '</span></td>'
          + '<td><code>' + item.activationCode + '</code></td>'
          + '<td>' + (employee || '-') + '</td>'
          + '<td><code>' + (item.folderName || '-') + '</code></td>'
          + '<td>' + (item.lastDeviceName || '-') + '<br/><code>' + (item.activeTokens || 0) + '/' + (item.tokenCount || 0) + '</code></td>'
          + '<td>' + (item.lastTokenUsedAt || item.lastActivatedAt || '-') + '</td>'
          + '<td>'
          + '<button class="secondary" data-copy="' + item.activationCode + '">复制</button> '
          + (item.enabled
            ? '<button class="danger" data-disable="' + item.activationCode + '">禁用</button>'
            : '<button class="secondary" data-enable="' + item.activationCode + '">启用</button>')
          + ' <button class="danger" data-delete="' + item.activationCode + '">删除</button>'
          + '</td>'
          + '</tr>';
      }).join('');
      $('tbody').innerHTML = rows || '<tr><td colspan="7">暂无激活码。</td></tr>';
    };
    const load = async () => {
      status('正在加载...');
      const data = await request('/api/admin/activation-codes', { method: 'GET' });
      state.codes = data.codes || [];
      render();
      status('已刷新');
    };
    const create = async () => {
      const payload = {
        displayName: $('displayName').value.trim(),
      };
      if (!payload.displayName) {
        status('请填写员工姓名', true);
        return;
      }
      status('正在生成...');
      const item = await request('/api/admin/activation-codes', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      $('displayName').value = '';
      await load();
      try {
        await copy(item.activationCode);
      } catch {
        status('已生成，请在列表中手动复制');
      }
    };
    const disableCode = async (activationCode) => {
      if (!confirm('确定禁用这个激活码？已签发 token 也会失效。')) return;
      status('正在禁用...');
      await request('/api/admin/activation-codes/disable', {
        method: 'POST',
        body: JSON.stringify({ activationCode }),
      });
      await load();
    };
    const enableCode = async (activationCode) => {
      status('正在启用...');
      await request('/api/admin/activation-codes/enable', {
        method: 'POST',
        body: JSON.stringify({ activationCode }),
      });
      await load();
    };
    const deleteCode = async (activationCode) => {
      if (!confirm('确定删除这个激活码？相关企业 token 也会被删除。')) return;
      status('正在删除...');
      await request('/api/admin/activation-codes/delete', {
        method: 'POST',
        body: JSON.stringify({ activationCode }),
      });
      await load();
    };
    $('reloadBtn').onclick = () => load().catch((error) => status(error.message, true));
    $('createBtn').onclick = () => create().catch((error) => status(error.message, true));
    $('tbody').onclick = (event) => {
      const copyCode = event.target.getAttribute('data-copy');
      const disable = event.target.getAttribute('data-disable');
      const enable = event.target.getAttribute('data-enable');
      const deleteTarget = event.target.getAttribute('data-delete');
      if (copyCode) copy(copyCode).catch((error) => status(error.message, true));
      if (disable) disableCode(disable).catch((error) => status(error.message, true));
      if (enable) enableCode(enable).catch((error) => status(error.message, true));
      if (deleteTarget) deleteCode(deleteTarget).catch((error) => status(error.message, true));
    };
    load().catch((error) => status(error.message, true));
  </script>
</body>
</html>`;
}

async function handleEnterpriseActivate(req, res) {
  try {
    const body = await readJsonBody(req);
    const activationCode = typeof body.activationCode === 'string'
      ? body.activationCode.trim()
      : '';
    if (!activationCode) {
      sendJson(res, 400, { code: 400, message: 'Missing activation code' });
      return;
    }

    const store = readActivationStore();
    const record = store.codes[activationCode];
    if (!record || record.enabled === false) {
      sendJson(res, 401, { code: 401, message: 'Activation code is invalid or disabled' });
      return;
    }

    const userId = String(record.userId || activationCode);
    const displayName = String(record.displayName || userId);
    const folderName = safePathSegment(record.folderName || `${userId}_${displayName}`);
    const activationToken = randomToken(32);
    const tokenHash = hashActivationToken(activationToken);
    store.tokens[tokenHash] = {
      enabled: true,
      userId,
      displayName,
      folderName,
      activationCodeHash: crypto.createHash('sha256').update(activationCode).digest('hex'),
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
      deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
      appVersion: typeof body.appVersion === 'string' ? body.appVersion : undefined,
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    record.lastActivatedAt = new Date().toISOString();
    record.lastDeviceName = typeof body.deviceName === 'string' ? body.deviceName : undefined;
    saveActivationStore(store);
    upsertUserInfo({
      userId,
      displayName,
      folderName,
      activationCode,
      activationEnabled: record.enabled !== false,
      status: 'activated',
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : undefined,
      deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
      appVersion: typeof body.appVersion === 'string' ? body.appVersion : undefined,
      lastActivatedAt: record.lastActivatedAt,
    });

    sendJson(res, 200, {
      code: 0,
      data: {
        activationToken,
        activationCode,
        userId,
        displayName,
        folderName,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleAdminListActivationCodes(req, res) {
  const store = readActivationStore();
  const codes = Object.entries(store.codes)
    .map(([code, record]) => publicActivationRecord(code, record || {}, store))
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      const aTime = a.updatedAt || a.createdAt || a.lastActivatedAt || '';
      const bTime = b.updatedAt || b.createdAt || b.lastActivatedAt || '';
      return String(bTime).localeCompare(String(aTime)) || String(a.userId).localeCompare(String(b.userId));
    });
  sendJson(res, 200, {
    code: 0,
    data: {
      codes,
      activationStorePath: getActivationStorePath(),
    },
  });
}

async function handleAdminCreateActivationCode(req, res) {
  try {
    const body = await readJsonBody(req);
    const now = new Date().toISOString();
    const displayName = String(body.displayName || body.name || '').trim();
    if (!displayName) {
      sendJson(res, 400, { code: 400, message: 'Missing displayName' });
      return;
    }

    const store = readActivationStore();
    const sameName = Object.entries(store.codes).find(([, record]) => (
      record
      && record.enabled !== false
      && normalizeDisplayName(record.displayName) === normalizeDisplayName(displayName)
    ));
    if (sameName) {
      sendJson(res, 409, {
        code: 409,
        message: '该员工姓名已经有启用中的激活码',
        data: publicActivationRecord(sameName[0], sameName[1], store),
      });
      return;
    }

    const identity = createActivationIdentity(displayName, store);
    const userId = String(body.userId || identity.userId).trim();
    const activationCode = String(body.activationCode || createActivationCode(identity.nameSlug)).trim().toUpperCase();
    const previous = store.codes[activationCode] || {};
    const folderName = safePathSegment(body.folderName || previous.folderName || identity.folderName);
    store.codes[activationCode] = {
      ...previous,
      enabled: body.enabled === undefined ? true : body.enabled !== false,
      userId,
      displayName,
      folderName,
      createdAt: previous.createdAt || now,
      updatedAt: now,
    };
    saveActivationStore(store);
    upsertUserInfo({
      userId,
      displayName,
      folderName,
      activationCode,
      activationEnabled: store.codes[activationCode].enabled !== false,
      status: 'created',
    });

    sendJson(res, 200, {
      code: 0,
      data: publicActivationRecord(activationCode, store.codes[activationCode], store),
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleAdminDisableActivationCode(req, res) {
  try {
    const body = await readJsonBody(req);
    const activationCode = String(body.activationCode || '').trim().toUpperCase();
    if (!activationCode) {
      sendJson(res, 400, { code: 400, message: 'Missing activationCode' });
      return;
    }

    const store = readActivationStore();
    const record = store.codes[activationCode];
    if (!record) {
      sendJson(res, 404, { code: 404, message: 'Activation code not found' });
      return;
    }

    const codeHash = hashActivationCode(activationCode);
    let disabledTokens = 0;
    record.enabled = false;
    record.disabledAt = new Date().toISOString();
    for (const tokenEntry of Object.values(store.tokens || {})) {
      if (tokenEntry.activationCodeHash !== codeHash) continue;
      if (tokenEntry.enabled !== false) disabledTokens += 1;
      tokenEntry.enabled = false;
      tokenEntry.disabledAt = record.disabledAt;
    }
    const invalidatedRuntime = invalidateRuntimeForActivation(store, activationCode, record, 'activation-disabled');
    saveActivationStore(store);
    upsertUserInfo({
      userId: record.userId,
      displayName: record.displayName,
      folderName: record.folderName,
      activationCode,
      activationEnabled: false,
      status: 'disabled',
    });

    sendJson(res, 200, {
      code: 0,
      data: {
        ...publicActivationRecord(activationCode, record, store),
        disabledTokens,
        invalidatedRuntime,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleAdminEnableActivationCode(req, res) {
  try {
    const body = await readJsonBody(req);
    const activationCode = String(body.activationCode || '').trim().toUpperCase();
    if (!activationCode) {
      sendJson(res, 400, { code: 400, message: 'Missing activationCode' });
      return;
    }

    const store = readActivationStore();
    const record = store.codes[activationCode];
    if (!record) {
      sendJson(res, 404, { code: 404, message: 'Activation code not found' });
      return;
    }

    const sameName = Object.entries(store.codes).find(([code, item]) => (
      code !== activationCode
      && item
      && item.enabled !== false
      && normalizeDisplayName(item.displayName) === normalizeDisplayName(record.displayName)
    ));
    if (sameName) {
      sendJson(res, 409, {
        code: 409,
        message: '该员工姓名已经有其他启用中的激活码',
        data: publicActivationRecord(sameName[0], sameName[1], store),
      });
      return;
    }

    const codeHash = hashActivationCode(activationCode);
    let enabledTokens = 0;
    record.enabled = true;
    record.enabledAt = new Date().toISOString();
    delete record.disabledAt;
    for (const tokenEntry of Object.values(store.tokens || {})) {
      if (tokenEntry.activationCodeHash !== codeHash) continue;
      if (tokenEntry.enabled === false) enabledTokens += 1;
      tokenEntry.enabled = true;
      tokenEntry.enabledAt = record.enabledAt;
      delete tokenEntry.disabledAt;
    }
    saveActivationStore(store);
    upsertUserInfo({
      userId: record.userId,
      displayName: record.displayName,
      folderName: record.folderName,
      activationCode,
      activationEnabled: true,
      status: 'enabled',
    });

    sendJson(res, 200, {
      code: 0,
      data: {
        ...publicActivationRecord(activationCode, record, store),
        enabledTokens,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleAdminDeleteActivationCode(req, res) {
  try {
    const body = await readJsonBody(req);
    const activationCode = String(body.activationCode || '').trim().toUpperCase();
    if (!activationCode) {
      sendJson(res, 400, { code: 400, message: 'Missing activationCode' });
      return;
    }

    const store = readActivationStore();
    const record = store.codes[activationCode];
    if (!record) {
      sendJson(res, 404, { code: 404, message: 'Activation code not found' });
      return;
    }

    const codeHash = hashActivationCode(activationCode);
    let deletedTokens = 0;
    const invalidatedRuntime = invalidateRuntimeForActivation(store, activationCode, record, 'activation-deleted');
    for (const tokenHash of Object.keys(store.tokens || {})) {
      if (store.tokens[tokenHash]?.activationCodeHash !== codeHash) continue;
      delete store.tokens[tokenHash];
      deletedTokens += 1;
    }
    delete store.codes[activationCode];
    saveActivationStore(store);
    upsertUserInfo({
      userId: record.userId,
      displayName: record.displayName,
      folderName: record.folderName,
      activationCode,
      activationEnabled: false,
      status: 'deleted',
    });

    sendJson(res, 200, {
      code: 0,
      data: {
        activationCode,
        userId: record.userId,
        displayName: record.displayName,
        folderName: record.folderName,
        deletedTokens,
        invalidatedRuntime,
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleEnterpriseFileDownload(req, res, url) {
  try {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const user = await resolveUserFromBearer(bearer);
    const targetPath = resolveAllowedDownloadPath(user, url.searchParams.get('path') || '');
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { code: 404, message: 'File not found' });
      return;
    }
    const fileName = path.basename(targetPath).replace(/[\r\n"]/g, '_') || 'download';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(targetPath).pipe(res);
  } catch (error) {
    const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleEnterpriseReleaseLatest(req, res) {
  try {
    const latestPath = path.join(config.releasesRoot, 'latest.json');
    const latest = readJsonIfExists(latestPath, null);
    if (!latest || typeof latest !== 'object') {
      sendJson(res, 404, { code: 404, message: 'Release manifest not found' });
      return;
    }

    const publicLatest = {
      ...latest,
      channels: { ...(latest.channels || {}) },
    };
    for (const channel of Object.values(publicLatest.channels)) {
      if (!channel || typeof channel !== 'object' || !Array.isArray(channel.files)) continue;
      channel.files = channel.files.map((file) => {
        const filePath = String(file.path || '').trim();
        return {
          ...file,
          ...(filePath
            ? { url: `${config.publicBaseUrl}/api/enterprise/releases/download?path=${encodeURIComponent(filePath)}` }
            : {}),
        };
      });
    }
    sendJson(res, 200, publicLatest);
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleEnterpriseReleaseDownload(req, res, url) {
  try {
    const targetPath = resolveReleaseFilePath(url.searchParams.get('path') || '');
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { code: 404, message: 'Release file not found' });
      return;
    }
    const fileName = path.basename(targetPath).replace(/[\r\n"]/g, '_') || 'LfClaw-installer';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'public, max-age=300',
    });
    fs.createReadStream(targetPath).pipe(res);
  } catch (error) {
    const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

async function handleEnterpriseActivationStatus(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const user = await resolveUserFromBearer(bearer);
    sendJson(res, 200, {
      code: 0,
      data: {
        activated: true,
        activation: {
          activationCode: user.activationCode,
          userId: user.id,
          displayName: user.displayName,
          folderName: user.folderName,
        },
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      code: status,
      data: { activated: false },
      message: error.message || String(error),
    });
  }
}

async function handleGatewayToken(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
    const user = await resolveUserFromBearer(bearer);
    const entry = await ensureUserGateway(user);
    const lease = createLease(entry);
    const gatewayUrl = `${config.publicBaseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')}/gateway/${lease.leaseId}`;
    sendJson(res, 200, {
      code: 0,
      data: {
        gatewayUrl,
        token: lease.token,
        model: config.model,
        allowInsecurePrivateWs: gatewayUrl.startsWith('ws://'),
        expiresAt: new Date(lease.expiresAt).toISOString(),
        activation: {
          activationCode: user.activationCode,
          userId: user.id,
          displayName: user.displayName,
          folderName: user.folderName,
        },
      },
    });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, { code: status, message: error.message || String(error) });
  }
}

function handleHttp(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      users: users.size,
      leases: leases.size,
      port: config.port,
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/admin') {
    sendHtml(res, 200, getAdminHtml());
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/enterprise/activate') {
    void handleEnterpriseActivate(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/enterprise/files/download') {
    void handleEnterpriseFileDownload(req, res, url);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/enterprise/releases/latest') {
    void handleEnterpriseReleaseLatest(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/enterprise/releases/download') {
    void handleEnterpriseReleaseDownload(req, res, url);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/enterprise/activation/status') {
    void handleEnterpriseActivationStatus(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/activation-codes') {
    void handleAdminListActivationCodes(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/activation-codes') {
    void handleAdminCreateActivationCode(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/activation-codes/disable') {
    void handleAdminDisableActivationCode(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/activation-codes/enable') {
    void handleAdminEnableActivationCode(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/activation-codes/delete') {
    void handleAdminDeleteActivationCode(req, res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/openclaw/gateway-token') {
    void handleGatewayToken(req, res);
    return;
  }
  sendJson(res, 404, { code: 404, message: 'Not found' });
}

function pipeUpgradeToOpenClaw(req, socket, head) {
  const match = /^\/gateway\/([A-Za-z0-9_-]+)/.exec(req.url || '');
  const leaseId = match?.[1];
  const lease = leaseId ? leases.get(leaseId) : null;
  if (!lease || lease.expiresAt < Date.now()) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const entry = users.get(lease.userKey);
  if (entry) entry.lastUsedAt = Date.now();
  lease.expiresAt = Date.now() + Math.max(config.idleMs, 5 * 60 * 1000);

  const upstream = net.connect({ host: '127.0.0.1', port: lease.port }, () => {
    const rewrittenUrl = '/';
    const firstLine = `${req.method} ${rewrittenUrl} HTTP/${req.httpVersion}\r\n`;
    const headers = Object.entries(req.headers)
      .filter(([key]) => key.toLowerCase() !== 'host')
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`)
      .join('\r\n');
    upstream.write(`${firstLine}Host: 127.0.0.1:${lease.port}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => {
    socket.destroy();
  });
}

function cleanupIdleUsers() {
  const now = Date.now();
  for (const [leaseId, lease] of leases.entries()) {
    if (lease.expiresAt < now) leases.delete(leaseId);
  }
  for (const [userKey, entry] of users.entries()) {
    if (now - entry.lastUsedAt < config.idleMs) continue;
    log(`Stopping idle OpenClaw user=${userKey} port=${entry.port}`);
    entry.process?.kill('SIGTERM');
    users.delete(userKey);
  }
}

ensureDir(config.dataRoot);
ensureActivationStore();
syncActivationCodeUserInfo();
const server = http.createServer(handleHttp);
server.on('upgrade', pipeUpgradeToOpenClaw);
server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port}`);
  log(`public base url: ${config.publicBaseUrl}`);
  log(`data root: ${config.dataRoot}`);
  log(`releases root: ${config.releasesRoot}`);
});

setInterval(cleanupIdleUsers, Math.min(config.idleMs, 60_000)).unref();
