export const EnterpriseIpcChannel = {
  GetStatus: 'enterprise:getStatus',
  Activate: 'enterprise:activate',
  SyncPolicy: 'enterprise:syncPolicy',
  DeactivateCurrent: 'enterprise:deactivateCurrent',
  SetServerUrl: 'enterprise:setServerUrl',
} as const;

export type EnterpriseIpcChannel = typeof EnterpriseIpcChannel[keyof typeof EnterpriseIpcChannel];

export interface EnterpriseQuota {
  planName: string;
  subscriptionStatus: 'active';
  creditsLimit: number;
  creditsUsed: number;
  creditsRemaining: number;
  hasPaidCredits: boolean;
}

export interface EnterpriseUser {
  yid: string;
  nickname: string;
  avatarUrl: string | null;
  userId: string;
  status: number;
}

export interface EnterprisePolicy {
  allowedModelIds: string[];
  allowedModelProviderIds?: string[];
  allowedMcpServerIds: string[];
  allowedSkillIds: string[];
  asr?: {
    provider: 'aliyun-dashscope';
    name?: string;
    workspaceId?: string;
    region?: string;
    apiHost?: string;
    websocketUrl?: string;
    model?: string;
    format?: 'wav' | 'pcm';
    sampleRate?: number;
    chunkIntervalMillis?: number;
    maxSessionSeconds?: number;
    configured?: boolean;
  };
  modelProviders?: Array<{
    id: string;
    name: string;
    provider: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: 'openai' | 'anthropic' | 'gemini';
    models: Array<{
      id: string;
      name: string;
      supportsImage?: boolean;
      supportsThinking?: boolean;
      modelTypes?: string[];
      contextWindow?: number;
    }>;
    costPerCall?: number;
    description?: string;
  }>;
  mcpServers?: Array<{
    id: string;
    name: string;
    description?: string;
    transportType: 'stdio' | 'sse' | 'http' | 'streamable-http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    permissions?: Array<{
      id: string;
      name: string;
    }>;
  }>;
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    version?: string;
    packageFileName?: string;
    packageSha256?: string;
    packageSize?: number;
    downloadUrl?: string;
  }>;
  enterpriseSkills?: Array<{
    id: string;
    name: string;
    description?: string;
    version?: string;
    packageFileName?: string;
    packageSha256?: string;
    packageSize?: number;
    downloadUrl?: string;
  }>;
  skillsCatalog?: Array<{
    id: string;
    name: string;
    description?: string;
    version?: string;
    packageFileName?: string;
    packageSha256?: string;
    packageSize?: number;
    downloadUrl?: string;
  }>;
  skillDelivery?: {
    enabled: boolean;
    clientVersion?: string;
    minimumClientVersion?: string;
    guarded?: boolean;
    reason?: string;
  };
  adminUrl?: string;
  enterpriseName?: string;
}

export interface EnterpriseCurrentAccess {
  serverUrl: string;
  activationCode: string;
  accessToken: string;
  refreshToken?: string;
  user: EnterpriseUser;
  quota: EnterpriseQuota;
  policy: EnterprisePolicy;
  activatedAt: string;
  syncedAt: string;
}

export interface EnterpriseSkillInstallation {
  serverSkillId: string;
  installedSkillId?: string;
  version?: string;
  packageSha256?: string;
  packageFileName?: string;
  packageSkillIds?: string[];
  installedAt?: string;
  upgradedAt?: string;
}

export interface EnterpriseStatus {
  serverUrl: string;
  lastActivationCode?: string;
  access: EnterpriseCurrentAccess | null;
  enterpriseSkillInstallations?: EnterpriseSkillInstallation[];
}

export interface EnterpriseActivateInput {
  activationCode: string;
  serverUrl?: string;
}
