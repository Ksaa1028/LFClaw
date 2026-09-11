import { describe, expect, test } from 'vitest';

import type { EnterpriseOpenVikingPolicy } from '../../shared/enterprise/constants';
import {
  buildOpenVikingPluginEntry,
  removeManagedStockOpenVikingSlot,
} from './openVikingPluginConfig';

const policy = (overrides: Partial<EnterpriseOpenVikingPolicy> = {}): EnterpriseOpenVikingPolicy => ({
  enabled: true,
  baseUrl: 'https://enterprise.example.com/api/enterprise/openviking/',
  timeoutMs: 2_500,
  autoRecallTimeoutMs: 2_500,
  autoCapture: true,
  autoRecall: true,
  recallTargetTypes: ['user'],
  peerRole: 'none',
  commitTokenThresholdRatio: 0,
  commitKeepRecentCount: 0,
  enabledTools: ['memory_recall', 'memory_store', 'memory_forget'],
  enableAddResourceTool: false,
  ...overrides,
});

describe('buildOpenVikingPluginEntry', () => {
  test('enables the plugin with a constrained fail-open configuration', () => {
    expect(buildOpenVikingPluginEntry({ policy: policy(), apiKey: 'enterprise-token' }, true)).toEqual({
      enabled: true,
      hooks: {
        allowConversationAccess: true,
      },
      config: {
        baseUrl: 'https://enterprise.example.com/api/enterprise/openviking',
        apiKey: '${LOBSTER_OPENVIKING_API_KEY}',
        autoCapture: true,
        autoRecall: true,
        timeoutMs: 2_500,
        autoRecallTimeoutMs: 2_500,
      },
    });
  });

  test('stays disabled when policy, credential, or bundled plugin is missing', () => {
    expect(buildOpenVikingPluginEntry(null, true)).toEqual({ enabled: false });
    expect(buildOpenVikingPluginEntry({ policy: policy(), apiKey: '' }, true)).toEqual({ enabled: false });
    expect(buildOpenVikingPluginEntry({ policy: policy({ enabled: false }), apiKey: 'token' }, true)).toEqual({ enabled: false });
    expect(buildOpenVikingPluginEntry({ policy: policy(), apiKey: 'token' }, false)).toEqual({ enabled: false });
  });
});

describe('removeManagedStockOpenVikingSlot', () => {
  test('removes a previously managed stock context-engine slot', () => {
    expect(removeManagedStockOpenVikingSlot({ memory: 'memory-core', contextEngine: 'openviking' })).toEqual({
      memory: 'memory-core',
    });
  });

  test('preserves a non-OpenViking context engine', () => {
    expect(removeManagedStockOpenVikingSlot({ contextEngine: 'custom' })).toEqual({
      contextEngine: 'custom',
    });
  });
});
