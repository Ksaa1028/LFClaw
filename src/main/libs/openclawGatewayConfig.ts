import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_LOCAL_GATEWAY_URL = 'http://localhost:18789';
const CONFIG_FILE_NAME = 'openclaw-gateway.json';
const ENTERPRISE_CONFIG_DIR_NAME = 'enterprise-config';

export type OpenClawGatewayMode = 'local' | 'remote';

export type OpenClawGatewayConfig = {
  mode: OpenClawGatewayMode;
  httpUrl: string;
  wsUrl: string;
  token: string | null;
  model: string | null;
  allowInsecurePrivateWs: boolean;
};

export type OpenClawGatewayFileConfig = {
  mode?: string;
  gatewayUrl?: string;
  url?: string;
  token?: string;
  model?: string;
  allowInsecurePrivateWs?: boolean;
};

let runtimeOpenClawGatewayConfig: OpenClawGatewayFileConfig | null = null;

const normalizeHttpUrl = (value: string): string => value.trim().replace(/\/+$/, '');

const toGatewayHttpUrl = (value: string): string => {
  const normalized = normalizeHttpUrl(value);
  if (/^wss:\/\//i.test(normalized)) {
    return normalized.replace(/^wss:\/\//i, 'https://');
  }
  if (/^ws:\/\//i.test(normalized)) {
    return normalized.replace(/^ws:\/\//i, 'http://');
  }
  return normalized;
};

const readJsonConfig = (filePath: string): OpenClawGatewayFileConfig | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? parsed as OpenClawGatewayFileConfig
      : null;
  } catch {
    return null;
  }
};

export function getOpenClawGatewayConfigFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicitConfig = env.LOBSTERAI_OPENCLAW_GATEWAY_CONFIG?.trim();
  if (explicitConfig) {
    return explicitConfig.toLowerCase() === 'none' ? [] : [explicitConfig];
  }

  const candidates = [
    path.join(os.homedir(), '.lobsterai', CONFIG_FILE_NAME),
  ];

  const appData = env.APPDATA?.trim();
  if (appData) {
    candidates.push(path.join(appData, 'LobsterAI', CONFIG_FILE_NAME));
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    candidates.push(path.join(xdgConfigHome, 'lobsterai', CONFIG_FILE_NAME));
  }

  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'LobsterAI', CONFIG_FILE_NAME));
  }

  return Array.from(new Set(candidates.filter((candidate): candidate is string => !!candidate)));
}

export function getEnterpriseOpenClawGatewayConfigFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicitEnterpriseConfig = env.LOBSTERAI_OPENCLAW_GATEWAY_ENTERPRISE_CONFIG?.trim();
  const defaultConfigDir = path.dirname(getDefaultOpenClawGatewayConfigFilePath(env));
  const candidates = [
    explicitEnterpriseConfig,
    path.join(defaultConfigDir, ENTERPRISE_CONFIG_DIR_NAME, CONFIG_FILE_NAME),
    process.resourcesPath ? path.join(process.resourcesPath, ENTERPRISE_CONFIG_DIR_NAME, CONFIG_FILE_NAME) : undefined,
    path.join(process.cwd(), 'resources', ENTERPRISE_CONFIG_DIR_NAME, CONFIG_FILE_NAME),
  ];

  return Array.from(new Set(candidates.filter((candidate): candidate is string => !!candidate)));
}

export function getDefaultOpenClawGatewayConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const appData = env.APPDATA?.trim();
  if (appData) {
    return path.join(appData, 'LobsterAI', CONFIG_FILE_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'LobsterAI', CONFIG_FILE_NAME);
  }
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'lobsterai', CONFIG_FILE_NAME);
  }
  return path.join(os.homedir(), '.lobsterai', CONFIG_FILE_NAME);
}

export function readOpenClawGatewayFileConfig(env: NodeJS.ProcessEnv = process.env): OpenClawGatewayFileConfig | null {
  if (env.LOBSTERAI_OPENCLAW_GATEWAY_CONFIG?.trim().toLowerCase() === 'none') {
    return null;
  }
  for (const candidate of getOpenClawGatewayConfigFileCandidates(env)) {
    const config = readJsonConfig(candidate);
    if (config) return config;
  }
  for (const candidate of getEnterpriseOpenClawGatewayConfigFileCandidates(env)) {
    const config = readJsonConfig(candidate);
    if (config) return config;
  }
  return null;
}

const cleanOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

export function normalizeOpenClawGatewayFileConfig(input: OpenClawGatewayFileConfig): OpenClawGatewayFileConfig {
  const mode = cleanOptionalString(input.mode)?.toLowerCase();
  return {
    ...(mode === 'local' || mode === 'remote' ? { mode } : {}),
    ...(cleanOptionalString(input.gatewayUrl ?? input.url) ? { gatewayUrl: cleanOptionalString(input.gatewayUrl ?? input.url) } : {}),
    ...(cleanOptionalString(input.token) ? { token: cleanOptionalString(input.token) } : {}),
    ...(cleanOptionalString(input.model) ? { model: cleanOptionalString(input.model) } : {}),
    ...(input.allowInsecurePrivateWs === true ? { allowInsecurePrivateWs: true } : {}),
  };
}

export function writeOpenClawGatewayFileConfig(
  config: OpenClawGatewayFileConfig,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; config: OpenClawGatewayFileConfig } {
  const normalized = normalizeOpenClawGatewayFileConfig(config);
  const filePath = getDefaultOpenClawGatewayConfigFilePath(env);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return { path: filePath, config: normalized };
}

export function toGatewayWsUrl(httpUrl: string): string {
  const normalized = normalizeHttpUrl(httpUrl);
  if (/^https:\/\//i.test(normalized)) {
    return normalized.replace(/^https:\/\//i, 'wss://');
  }
  if (/^http:\/\//i.test(normalized)) {
    return normalized.replace(/^http:\/\//i, 'ws://');
  }
  return normalized;
}

export function setRuntimeOpenClawGatewayConfig(config: OpenClawGatewayFileConfig | null): void {
  runtimeOpenClawGatewayConfig = config ? normalizeOpenClawGatewayFileConfig(config) : null;
}

export function getRuntimeOpenClawGatewayToken(): string | null {
  return runtimeOpenClawGatewayConfig?.token?.trim() || null;
}

export function setRuntimeOpenClawGatewayToken(token: string | null): void {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  setRuntimeOpenClawGatewayConfig(trimmed ? { token: trimmed } : null);
}

export function getOpenClawGatewayConfig(env: NodeJS.ProcessEnv = process.env): OpenClawGatewayConfig {
  const fileConfig = readOpenClawGatewayFileConfig(env);
  const envMode = env.LOBSTERAI_OPENCLAW_GATEWAY_MODE?.trim().toLowerCase();
  const remoteUrl = env.LOBSTERAI_OPENCLAW_GATEWAY_URL?.trim()
    || runtimeOpenClawGatewayConfig?.gatewayUrl?.trim()
    || runtimeOpenClawGatewayConfig?.url?.trim()
    || fileConfig?.gatewayUrl?.trim()
    || fileConfig?.url?.trim();
  const mode: OpenClawGatewayMode = envMode === 'local'
    ? 'local'
    : (envMode === 'remote' || remoteUrl ? 'remote' : 'local');
  const httpUrl = mode === 'remote' && remoteUrl
    ? toGatewayHttpUrl(remoteUrl)
    : DEFAULT_LOCAL_GATEWAY_URL;
  const allowInsecurePrivateWs = env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === '1'
    || runtimeOpenClawGatewayConfig?.allowInsecurePrivateWs === true
    || fileConfig?.allowInsecurePrivateWs === true;

  return {
    mode,
    httpUrl,
    wsUrl: toGatewayWsUrl(httpUrl),
    token: env.LOBSTERAI_OPENCLAW_GATEWAY_TOKEN?.trim()
      || runtimeOpenClawGatewayConfig?.token?.trim()
      || fileConfig?.token?.trim()
      || null,
    model: env.LOBSTERAI_OPENCLAW_MODEL?.trim()
      || runtimeOpenClawGatewayConfig?.model?.trim()
      || fileConfig?.model?.trim()
      || null,
    allowInsecurePrivateWs,
  };
}

export function isRemoteOpenClawGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  return getOpenClawGatewayConfig(env).mode === 'remote';
}
