import type { EnterpriseOpenVikingPolicy } from '../../shared/enterprise/constants';

export const OPENVIKING_PLUGIN_ID = 'lfclaw-openviking-memory';
export const OPENVIKING_API_KEY_ENV = 'LOBSTER_OPENVIKING_API_KEY';

export type EnterpriseOpenVikingRuntimeConfig = {
  policy: EnterpriseOpenVikingPolicy;
  apiKey: string;
};

export const buildOpenVikingPluginEntry = (
  runtime: EnterpriseOpenVikingRuntimeConfig | null | undefined,
  pluginAvailable: boolean,
): {
  enabled: boolean;
  hooks?: { allowConversationAccess: boolean };
  config?: Record<string, unknown>;
} => {
  const policy = runtime?.policy;
  const apiKey = runtime?.apiKey?.trim() || '';
  const enabled = pluginAvailable === true
    && policy?.enabled === true
    && Boolean(policy.baseUrl?.trim())
    && Boolean(apiKey);

  if (!enabled || !policy) return { enabled: false };
  return {
    enabled: true,
    hooks: {
      allowConversationAccess: true,
    },
    config: {
      baseUrl: policy.baseUrl.replace(/\/+$/, ''),
      apiKey: `\${${OPENVIKING_API_KEY_ENV}}`,
      autoCapture: policy.autoCapture,
      autoRecall: policy.autoRecall,
      timeoutMs: policy.timeoutMs,
      autoRecallTimeoutMs: policy.autoRecallTimeoutMs,
    },
  };
};

export const removeManagedStockOpenVikingSlot = (
  existingSlots: Record<string, unknown> | null | undefined,
): Record<string, unknown> => Object.fromEntries(
  Object.entries(existingSlots ?? {}).filter(([key, value]) => (
    key !== 'contextEngine' || value !== 'openviking'
  )),
);
