import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  getOpenClawGatewayConfig,
  setRuntimeOpenClawGatewayConfig,
  setRuntimeOpenClawGatewayToken,
  toGatewayWsUrl,
} from './openclawGatewayConfig';

describe('openclawGatewayConfig', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setRuntimeOpenClawGatewayToken(null);
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('uses local gateway defaults', () => {
    expect(getOpenClawGatewayConfig({
      LOBSTERAI_OPENCLAW_GATEWAY_CONFIG: 'none',
    })).toEqual({
      mode: 'local',
      httpUrl: 'http://localhost:18789',
      wsUrl: 'ws://localhost:18789',
      token: null,
      model: null,
      allowInsecurePrivateWs: false,
    });
  });

  test('uses remote gateway env vars', () => {
    expect(getOpenClawGatewayConfig({
      LOBSTERAI_OPENCLAW_GATEWAY_MODE: 'remote',
      LOBSTERAI_OPENCLAW_GATEWAY_URL: 'http://78.216.38.213:18790/',
      LOBSTERAI_OPENCLAW_GATEWAY_TOKEN: 'secret',
      LOBSTERAI_OPENCLAW_MODEL: 'zai/glm-5.2',
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: '1',
    })).toEqual({
      mode: 'remote',
      httpUrl: 'http://78.216.38.213:18790',
      wsUrl: 'ws://78.216.38.213:18790',
      token: 'secret',
      model: 'zai/glm-5.2',
      allowInsecurePrivateWs: true,
    });
  });

  test('converts https gateway URLs to secure websockets', () => {
    expect(toGatewayWsUrl('https://agent.example.com/')).toBe('wss://agent.example.com');
  });

  test('uses enterprise default config when user config is missing', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-gateway-'));
    tempDirs.push(tempDir);
    const enterpriseConfigPath = path.join(tempDir, 'enterprise-openclaw-gateway.json');
    fs.writeFileSync(enterpriseConfigPath, JSON.stringify({
      mode: 'remote',
      gatewayUrl: 'https://gateway.example.com/',
      token: 'enterprise-token',
      model: 'zai/glm-5.2',
    }), 'utf8');

    expect(getOpenClawGatewayConfig({
      LOBSTERAI_OPENCLAW_GATEWAY_ENTERPRISE_CONFIG: enterpriseConfigPath,
      LOBSTERAI_OPENCLAW_GATEWAY_CONFIG: path.join(tempDir, 'missing-user-config.json'),
    })).toMatchObject({
      mode: 'remote',
      httpUrl: 'https://gateway.example.com',
      wsUrl: 'wss://gateway.example.com',
      token: 'enterprise-token',
      model: 'zai/glm-5.2',
    });
  });

  test('prefers user config over enterprise default config', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-gateway-'));
    tempDirs.push(tempDir);
    const userConfigPath = path.join(tempDir, 'user-openclaw-gateway.json');
    const enterpriseConfigPath = path.join(tempDir, 'enterprise-openclaw-gateway.json');
    fs.writeFileSync(userConfigPath, JSON.stringify({
      gatewayUrl: 'https://user-gateway.example.com',
      token: 'user-token',
      model: 'zai/glm-5.1',
    }), 'utf8');
    fs.writeFileSync(enterpriseConfigPath, JSON.stringify({
      gatewayUrl: 'https://enterprise-gateway.example.com',
      token: 'enterprise-token',
      model: 'zai/glm-5.2',
    }), 'utf8');

    expect(getOpenClawGatewayConfig({
      LOBSTERAI_OPENCLAW_GATEWAY_CONFIG: userConfigPath,
      LOBSTERAI_OPENCLAW_GATEWAY_ENTERPRISE_CONFIG: enterpriseConfigPath,
    })).toMatchObject({
      mode: 'remote',
      httpUrl: 'https://user-gateway.example.com',
      token: 'user-token',
      model: 'zai/glm-5.1',
    });
  });

  test('uses runtime personal token over configured file token', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-gateway-'));
    tempDirs.push(tempDir);
    const userConfigPath = path.join(tempDir, 'user-openclaw-gateway.json');
    fs.writeFileSync(userConfigPath, JSON.stringify({
      gatewayUrl: 'https://gateway.example.com',
      token: 'file-token',
    }), 'utf8');
    setRuntimeOpenClawGatewayToken('personal-token');

    expect(getOpenClawGatewayConfig({
      LOBSTERAI_OPENCLAW_GATEWAY_CONFIG: userConfigPath,
    })).toMatchObject({
      mode: 'remote',
      token: 'personal-token',
    });
  });

  test('keeps env gateway token higher priority than runtime personal token', () => {
    setRuntimeOpenClawGatewayToken('personal-token');

    expect(getOpenClawGatewayConfig({
      LOBSTERAI_OPENCLAW_GATEWAY_CONFIG: 'none',
      LOBSTERAI_OPENCLAW_GATEWAY_MODE: 'remote',
      LOBSTERAI_OPENCLAW_GATEWAY_URL: 'https://gateway.example.com',
      LOBSTERAI_OPENCLAW_GATEWAY_TOKEN: 'env-token',
    })).toMatchObject({
      mode: 'remote',
      token: 'env-token',
    });
  });

  test('uses runtime gateway config returned by manager', () => {
    setRuntimeOpenClawGatewayConfig({
      gatewayUrl: 'http://8.216.38.213:18791/gateway/lease-a',
      token: 'lease-token',
      model: 'zai/glm-5.2',
      allowInsecurePrivateWs: true,
    });

    expect(getOpenClawGatewayConfig({
      LOBSTERAI_OPENCLAW_GATEWAY_CONFIG: 'none',
    })).toEqual({
      mode: 'remote',
      httpUrl: 'http://8.216.38.213:18791/gateway/lease-a',
      wsUrl: 'ws://8.216.38.213:18791/gateway/lease-a',
      token: 'lease-token',
      model: 'zai/glm-5.2',
      allowInsecurePrivateWs: true,
    });
  });
});
