import crypto from 'crypto';
import { app, net } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AsrRealtimeSessionData, AsrRealtimeSessionRequest } from '../../shared/asr/constants';
import { AuthSubscriptionStatus } from '../../shared/auth/constants';
import type {
  EnterpriseActivateInput,
  EnterpriseCurrentAccess,
  EnterprisePolicy,
  EnterpriseQuota,
  EnterpriseStatus,
  EnterpriseUser,
} from '../../shared/enterprise/constants';
import { ProviderRegistry } from '../../shared/providers';
import type { SqliteStore } from '../sqliteStore';

const ENTERPRISE_ACCESS_KEY = 'lfclaw_enterprise_access';
const ENTERPRISE_LAST_ACTIVATION_CODE_KEY = 'lfclaw_enterprise_last_activation_code';
const ENTERPRISE_SERVER_URL_KEY = 'lfclaw_enterprise_server_url';
const ENTERPRISE_SERVER_URL_ENV = 'LFCLAW_ENTERPRISE_BASE_URL';
const ENTERPRISE_SERVER_URL_DEFAULT = 'http://127.0.0.1:8787';
const ENTERPRISE_CONFIG_FILENAME = 'enterprise.json';

type ApiEnvelope = {
  code?: number;
  message?: string;
  data?: unknown;
};

const nowIso = (): string => new Date().toISOString();

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const normalizeUrl = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
};

const stringList = (value: unknown): string[] => (
  Array.isArray(value)
    ? Array.from(new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())))
    : []
);

const numberValue = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const recordList = (value: unknown): Record<string, unknown>[] => (
  Array.isArray(value) ? value.filter(isRecord) : []
);

const normalizeEnterpriseSkills = (value: unknown): NonNullable<EnterprisePolicy['skills']> => (
  recordList(value).map(skill => ({
    id: String(skill.id || '').trim(),
    name: String(skill.name || skill.id || '').trim(),
    description: typeof skill.description === 'string' ? skill.description : undefined,
    version: typeof skill.version === 'string' ? skill.version : undefined,
    packageFileName: typeof skill.packageFileName === 'string' ? skill.packageFileName : undefined,
    packageSha256: typeof skill.packageSha256 === 'string' ? skill.packageSha256 : undefined,
    packageSize: typeof skill.packageSize === 'number' ? skill.packageSize : undefined,
    downloadUrl: typeof skill.downloadUrl === 'string' ? skill.downloadUrl : undefined,
  })).filter(skill => skill.id)
);

const normalizeApiFormat = (value: unknown): 'openai' | 'anthropic' | 'gemini' => (
  value === 'anthropic' || value === 'gemini' ? value : 'openai'
);

const normalizeMcpTransportType = (value: unknown): 'stdio' | 'sse' | 'http' | 'streamable-http' => (
  value === 'stdio' || value === 'http' || value === 'streamable-http' ? value : 'sse'
);

const normalizeAsrFormat = (_value: unknown): 'pcm' => 'pcm';

export class LFClawEnterpriseAccess {
  constructor(
    private readonly store: SqliteStore,
    private readonly getClientVersion: () => string = () => app.getVersion(),
  ) {}

  getServerUrl(): string {
    return normalizeUrl(process.env[ENTERPRISE_SERVER_URL_ENV])
      || normalizeUrl(this.store.get<string>(ENTERPRISE_SERVER_URL_KEY))
      || this.getBundledServerUrl()
      || ENTERPRISE_SERVER_URL_DEFAULT;
  }

  setServerUrl(serverUrl: string): EnterpriseStatus {
    const normalized = normalizeUrl(serverUrl);
    if (!normalized) {
      throw new Error('Enterprise server URL must be an HTTP or HTTPS URL.');
    }
    this.store.set(ENTERPRISE_SERVER_URL_KEY, normalized);
    return this.getStatus();
  }

  getStatus(): EnterpriseStatus {
    return {
      serverUrl: this.getServerUrl(),
      lastActivationCode: this.store.get<string>(ENTERPRISE_LAST_ACTIVATION_CODE_KEY) || undefined,
      access: this.getCurrentAccess(),
    };
  }

  getCurrentAccess(): EnterpriseCurrentAccess | null {
    const access = this.store.get<EnterpriseCurrentAccess>(ENTERPRISE_ACCESS_KEY);
    if (!access || !access.accessToken || !access.activationCode) return null;
    return this.normalizeAccess(access);
  }

  async activate(input: EnterpriseActivateInput): Promise<EnterpriseCurrentAccess> {
    const serverUrl = normalizeUrl(input.serverUrl) || this.getServerUrl();
    if (!serverUrl) {
      throw new Error('Enterprise server URL is not configured.');
    }
    this.store.set(ENTERPRISE_SERVER_URL_KEY, serverUrl);

    const activationCode = input.activationCode.trim().toUpperCase();
    if (!activationCode) {
      throw new Error('Activation code is required.');
    }
    this.store.set(ENTERPRISE_LAST_ACTIVATION_CODE_KEY, activationCode);

    const payload = await this.request(serverUrl, '/api/enterprise/activate', {
      method: 'POST',
      body: {
        activationCode,
        deviceToken: this.getDeviceToken(),
        deviceName: os.hostname(),
        platform: process.platform,
        clientVersion: this.getClientVersion(),
      },
    });

    const access = this.normalizeAccessFromPayload(serverUrl, activationCode, payload);
    this.store.set(ENTERPRISE_ACCESS_KEY, access);
    return access;
  }

  async syncPolicy(): Promise<EnterpriseCurrentAccess | null> {
    const current = this.getCurrentAccess();
    if (!current) return null;

    const clientVersion = encodeURIComponent(this.getClientVersion());
    const payload = await this.request(current.serverUrl, `/api/enterprise/me?clientVersion=${clientVersion}`, {
      method: 'GET',
      accessToken: current.accessToken,
    });
    const synced = this.normalizeAccessFromPayload(current.serverUrl, current.activationCode, {
      ...payload,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
    });
    this.store.set(ENTERPRISE_ACCESS_KEY, synced);
    return synced;
  }

  async requireActiveAccess(): Promise<EnterpriseCurrentAccess> {
    const current = this.getCurrentAccess();
    if (!current) {
      throw new Error('请先完成企业激活后再使用。');
    }
    try {
      const synced = await this.syncPolicy();
      if (!synced) {
        throw new Error('请先完成企业激活后再使用。');
      }
      return synced;
    } catch (error) {
      this.deactivateCurrent();
      throw error instanceof Error
        ? error
        : new Error('企业激活状态校验失败，请重新激活。');
    }
  }

  deactivateCurrent(): void {
    this.store.delete(ENTERPRISE_ACCESS_KEY);
  }

  async reportUsage(input: {
    modelId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    credits?: number;
  }): Promise<void> {
    const current = this.getCurrentAccess();
    if (!current) return;
    await this.request(current.serverUrl, '/api/enterprise/usage', {
      method: 'POST',
      accessToken: current.accessToken,
      body: {
        modelId: input.modelId || 'unknown',
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        cacheWriteTokens: input.cacheWriteTokens ?? 0,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        ...(input.credits !== undefined ? { credits: input.credits } : {}),
      },
    });
  }

  async createAsrRealtimeSession(options?: AsrRealtimeSessionRequest): Promise<AsrRealtimeSessionData> {
    const current = await this.requireActiveAccess();
    const payload = await this.request(current.serverUrl, '/api/enterprise/asr/realtime/sessions', {
      method: 'POST',
      accessToken: current.accessToken,
      body: {
        langType: options?.langType,
      },
    });

    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    const wsUrl = typeof payload.wsUrl === 'string' ? payload.wsUrl : '';
    if (!requestId || !wsUrl) {
      throw new Error('Enterprise ASR server did not return a valid realtime session.');
    }

    return {
      requestId,
      wsUrl,
      expiresInSeconds: numberValue(payload.expiresInSeconds) || 120,
      chunkIntervalMillis: numberValue(payload.chunkIntervalMillis) || 200,
      maxSessionSeconds: numberValue(payload.maxSessionSeconds) || 60,
      audioFormat: normalizeAsrFormat(payload.audioFormat ?? payload.format),
      maxConcurrentSessions: numberValue(payload.maxConcurrentSessions) || 1,
      usedSecondsToday: numberValue(payload.usedSecondsToday),
      remainingSecondsToday: numberValue(payload.remainingSecondsToday) || 86400,
      limitSecondsToday: numberValue(payload.limitSecondsToday) || 86400,
    };
  }

  isModelAllowed(modelId: string): boolean {
    const allowed = this.getCurrentAccess()?.policy.allowedModelIds;
    const normalizedModelId = modelId.includes('/') ? modelId.split('/').pop() || modelId : modelId;
    return Array.isArray(allowed) && (allowed.includes(modelId) || allowed.includes(normalizedModelId));
  }

  isMcpAllowed(serverId: string, registryId?: string | null, name?: string | null): boolean {
    const allowed = this.getCurrentAccess()?.policy.allowedMcpServerIds;
    const normalizedRegistryId = registryId?.startsWith('enterprise:')
      ? registryId.slice('enterprise:'.length)
      : registryId;
    return Array.isArray(allowed)
      && (
        allowed.includes(serverId)
        || (!!registryId && allowed.includes(registryId))
        || (!!normalizedRegistryId && allowed.includes(normalizedRegistryId))
        || (!!name && allowed.includes(name))
      );
  }

  isSkillAllowed(skillId: string): boolean {
    const allowed = this.getCurrentAccess()?.policy.allowedSkillIds;
    return Array.isArray(allowed) && allowed.includes(skillId);
  }

  private async request(
    serverUrl: string,
    path: string,
    options: {
      method: 'GET' | 'POST';
      body?: Record<string, unknown>;
      accessToken?: string;
    },
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-LFClaw-Client-Version': this.getClientVersion(),
    };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

    const response = await net.fetch(`${serverUrl}${path}`, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) as ApiEnvelope | Record<string, unknown> : {};
    if (!response.ok) {
      throw new Error(isRecord(parsed) && typeof parsed.message === 'string' ? parsed.message : `Enterprise server returned HTTP ${response.status}.`);
    }
    if (isRecord(parsed) && typeof parsed.code === 'number') {
      if (parsed.code !== 0) {
        throw new Error(typeof parsed.message === 'string' ? parsed.message : 'Enterprise server rejected the request.');
      }
      return isRecord(parsed.data) ? parsed.data : {};
    }
    return isRecord(parsed) ? parsed : {};
  }

  private normalizeAccessFromPayload(
    serverUrl: string,
    activationCode: string,
    payload: Record<string, unknown>,
  ): EnterpriseCurrentAccess {
    const current = this.getCurrentAccess();
    const user = this.normalizeUser(payload.user, current?.user);
    const quota = this.normalizeQuota(payload.quota, current?.quota);
    const policy = this.normalizePolicy(payload.policy, current?.policy);
    const accessToken = typeof payload.accessToken === 'string' && payload.accessToken.trim()
      ? payload.accessToken.trim()
      : current?.accessToken;
    if (!accessToken) {
      throw new Error('Enterprise server did not return an access token.');
    }

    return {
      serverUrl,
      activationCode,
      accessToken,
      refreshToken: typeof payload.refreshToken === 'string' ? payload.refreshToken : current?.refreshToken,
      user,
      quota,
      policy,
      activatedAt: current?.activatedAt ?? nowIso(),
      syncedAt: nowIso(),
    };
  }

  private normalizeAccess(access: EnterpriseCurrentAccess): EnterpriseCurrentAccess {
    return {
      serverUrl: normalizeUrl(access.serverUrl),
      activationCode: String(access.activationCode || '').trim().toUpperCase(),
      accessToken: String(access.accessToken || ''),
      refreshToken: typeof access.refreshToken === 'string' ? access.refreshToken : undefined,
      user: this.normalizeUser(access.user),
      quota: this.normalizeQuota(access.quota),
      policy: this.normalizePolicy(access.policy),
      activatedAt: typeof access.activatedAt === 'string' ? access.activatedAt : nowIso(),
      syncedAt: typeof access.syncedAt === 'string' ? access.syncedAt : nowIso(),
    };
  }

  private normalizeUser(value: unknown, fallback?: EnterpriseUser): EnterpriseUser {
    const raw = isRecord(value) ? value : {};
    const id = typeof raw.userId === 'string' && raw.userId.trim()
      ? raw.userId.trim()
      : typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : fallback?.userId ?? 'enterprise-user';
    return {
      yid: typeof raw.yid === 'string' && raw.yid.trim() ? raw.yid.trim() : fallback?.yid ?? id,
      nickname: typeof raw.nickname === 'string' && raw.nickname.trim() ? raw.nickname.trim() : fallback?.nickname ?? id,
      avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : fallback?.avatarUrl ?? null,
      userId: id,
      status: typeof raw.status === 'number' ? raw.status : fallback?.status ?? 1,
    };
  }

  private normalizeQuota(value: unknown, fallback?: EnterpriseQuota): EnterpriseQuota {
    const raw = isRecord(value) ? value : {};
    const creditsLimit = numberValue(raw.creditsLimit ?? fallback?.creditsLimit);
    const creditsUsed = numberValue(raw.creditsUsed ?? fallback?.creditsUsed);
    return {
      planName: typeof raw.planName === 'string' && raw.planName.trim() ? raw.planName.trim() : fallback?.planName ?? 'LFClaw Enterprise',
      subscriptionStatus: AuthSubscriptionStatus.Active,
      creditsLimit,
      creditsUsed,
      creditsRemaining: numberValue(raw.creditsRemaining ?? fallback?.creditsRemaining ?? Math.max(0, creditsLimit - creditsUsed)),
      hasPaidCredits: true,
    };
  }

  private normalizePolicy(value: unknown, fallback?: EnterprisePolicy): EnterprisePolicy {
    const raw = isRecord(value) ? value : {};
    return {
      allowedModelIds: stringList(raw.allowedModelIds ?? fallback?.allowedModelIds),
      allowedModelProviderIds: stringList(raw.allowedModelProviderIds ?? fallback?.allowedModelProviderIds),
      allowedMcpServerIds: stringList(raw.allowedMcpServerIds ?? fallback?.allowedMcpServerIds),
      allowedSkillIds: stringList(raw.allowedSkillIds ?? fallback?.allowedSkillIds),
      asr: this.normalizeAsrPolicy(raw.asr ?? fallback?.asr),
      modelProviders: recordList(raw.modelProviders ?? fallback?.modelProviders).map(provider => ({
        id: String(provider.id || '').trim(),
        name: String(provider.name || provider.id || '').trim(),
        provider: String(provider.provider || 'custom').trim(),
        baseUrl: String(provider.baseUrl || '').trim(),
        apiKey: String(provider.apiKey || '').trim(),
        apiFormat: normalizeApiFormat(provider.apiFormat),
        models: recordList(provider.models).map(model => ({
          id: String(model.id || '').trim(),
          name: String(model.name || model.id || '').trim(),
          modelTypes: stringList(model.modelTypes),
          supportsImage: ProviderRegistry.resolveModelSupportsImage(
            String(provider.provider || provider.id || '').trim(),
            String(model.id || '').trim(),
            model.supportsImage === true,
          ),
          supportsThinking: model.supportsThinking === true,
          ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
        })).filter(model => model.id),
        ...(typeof provider.costPerCall === 'number' ? { costPerCall: provider.costPerCall } : {}),
        ...(typeof provider.description === 'string' ? { description: provider.description } : {}),
      })).filter(provider => provider.id && provider.baseUrl && provider.models.length > 0),
      mcpServers: recordList(raw.mcpServers ?? fallback?.mcpServers).map(server => ({
        id: String(server.id || '').trim(),
        name: String(server.name || server.id || '').trim(),
        description: typeof server.description === 'string' ? server.description : undefined,
        transportType: normalizeMcpTransportType(server.transportType),
        command: typeof server.command === 'string' ? server.command : undefined,
        args: stringList(server.args),
        env: isRecord(server.env) ? Object.fromEntries(Object.entries(server.env).map(([key, val]) => [key, String(val)])) : undefined,
        url: typeof server.url === 'string' ? server.url : undefined,
        headers: isRecord(server.headers) ? Object.fromEntries(Object.entries(server.headers).map(([key, val]) => [key, String(val)])) : undefined,
      })).filter(server => server.id),
      skills: normalizeEnterpriseSkills(raw.skills ?? fallback?.skills),
      enterpriseSkills: normalizeEnterpriseSkills(
        raw.enterpriseSkills
          ?? raw.skillsCatalog
          ?? fallback?.enterpriseSkills
          ?? fallback?.skillsCatalog,
      ),
      skillsCatalog: normalizeEnterpriseSkills(
        raw.skillsCatalog
          ?? raw.enterpriseSkills
          ?? fallback?.skillsCatalog
          ?? fallback?.enterpriseSkills,
      ),
      skillDelivery: this.normalizeSkillDelivery(raw.skillDelivery ?? fallback?.skillDelivery),
      adminUrl: typeof raw.adminUrl === 'string' && raw.adminUrl.trim() ? raw.adminUrl.trim() : fallback?.adminUrl,
      enterpriseName: typeof raw.enterpriseName === 'string' && raw.enterpriseName.trim() ? raw.enterpriseName.trim() : fallback?.enterpriseName,
    };
  }

  private normalizeSkillDelivery(value: unknown): EnterprisePolicy['skillDelivery'] | undefined {
    const raw = isRecord(value) ? value : {};
    if (!('enabled' in raw) && !('clientVersion' in raw) && !('minimumClientVersion' in raw) && !('guarded' in raw)) {
      return undefined;
    }
    return {
      enabled: raw.enabled !== false,
      clientVersion: typeof raw.clientVersion === 'string' ? raw.clientVersion : undefined,
      minimumClientVersion: typeof raw.minimumClientVersion === 'string' ? raw.minimumClientVersion : undefined,
      guarded: raw.guarded === true,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    };
  }

  private normalizeAsrPolicy(value: unknown): EnterprisePolicy['asr'] {
    const raw = isRecord(value) ? value : {};
    const provider = raw.provider === 'aliyun-dashscope' ? raw.provider : 'aliyun-dashscope';
    return {
      provider,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : undefined,
      region: typeof raw.region === 'string' ? raw.region : undefined,
      apiHost: typeof raw.apiHost === 'string' ? raw.apiHost : undefined,
      websocketUrl: typeof raw.websocketUrl === 'string' ? raw.websocketUrl : undefined,
      model: typeof raw.model === 'string' ? raw.model : undefined,
      format: normalizeAsrFormat(raw.format),
      sampleRate: numberValue(raw.sampleRate) || undefined,
      chunkIntervalMillis: numberValue(raw.chunkIntervalMillis) || undefined,
      maxSessionSeconds: numberValue(raw.maxSessionSeconds) || undefined,
      configured: raw.configured === true,
    };
  }

  private getDeviceToken(): string {
    const source = `${os.hostname()}::${os.userInfo().username}`;
    return crypto.createHash('sha256').update(source).digest('hex').slice(0, 16).toUpperCase();
  }

  private getBundledServerUrl(): string {
    const candidates = [
      path.join(process.cwd(), 'resources', ENTERPRISE_CONFIG_FILENAME),
      path.join(app.getAppPath(), 'resources', ENTERPRISE_CONFIG_FILENAME),
      path.join(process.resourcesPath || '', ENTERPRISE_CONFIG_FILENAME),
      path.join(path.dirname(process.execPath), ENTERPRISE_CONFIG_FILENAME),
    ];

    for (const configPath of candidates) {
      try {
        if (!configPath || !fs.existsSync(configPath)) continue;
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const configured = normalizeUrl(raw.enterpriseServerUrl ?? raw.serverUrl ?? raw.baseUrl);
        if (configured) return configured;
      } catch (error) {
        console.warn('[Enterprise] failed to read enterprise server config:', configPath, error);
      }
    }
    return '';
  }
}
