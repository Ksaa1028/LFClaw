import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

test('real /me keeps normal credentials stable, force-renews only the requested MCP, and respects saved floor grants', { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lfclaw-mcp-refresh-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const employee = { id: 'internal', employeeId: 'staff', employeeName: 'Test', activationCode: 'TEST', status: 'active', allowedMcpServerIds: ['dz2.0'], mcpPermissionGrants: { 'dz2.0': ['operation.floor.2'] } };
  await fs.writeFile(path.join(directory, 'enterprise-data.json'), JSON.stringify({
    permissionAssignmentMode: 'employee-only-v1', employees: [employee],
    mcpServers: [{ id: 'dz2.0', name: 'MCP', transportType: 'sse', url: 'http://127.0.0.1/sse2' }],
    sessions: { 'test-session': { activationCode: 'TEST', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() } },
  }));
  const child = spawn(process.execPath, ['enterprise-server/server.mjs'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LFCLAW_ENTERPRISE_HOST: '127.0.0.1', LFCLAW_ENTERPRISE_PORT: String(port), LFCLAW_ENTERPRISE_DATA: path.join(directory, 'enterprise-data.json'), LFCLAW_ENTERPRISE_DATA_DIR: directory, LFCLAW_ENTERPRISE_STORAGE: directory, LFCLAW_ENTERPRISE_RELEASE_DIR: directory, LFCLAW_ADMIN_TOKEN: 'test-admin', LFCLAW_MCP_PERMISSION_SECRET: 'test-secret', LFCLAW_MCP_PERMISSION_TTL_MS: String(10 * 60 * 1000) },
  });
  const exited = once(child, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test enterprise server did not start')), 10_000);
      child.stdout.on('data', data => { if (data.toString().includes('listening at')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const base = `http://127.0.0.1:${port}`;
    const read = async (suffix = '') => {
      const response = await fetch(`${base}/api/enterprise/me${suffix}`, { headers: { authorization: 'Bearer test-session' } });
      assert.equal(response.status, 200);
      return (await response.json()).data.policy.mcpServers[0].headers['x-lfclaw-permission-assertion'];
    };
    const first = await read();
    assert.equal(await read(), first);
    assert.equal(await read('?forceMcpRefresh=unauthorized-mcp'), first);
    const refreshed = await read('?forceMcpRefresh=dz2.0');
    assert.notEqual(refreshed, first);
    assert.equal(await read(), refreshed);
    const save = await fetch(`${base}/api/admin/employees/TEST`, {
      method: 'PATCH', headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
      body: JSON.stringify({ mcpPermissionGrants: { 'dz2.0': ['operation.floor.1'] } }),
    });
    assert.equal(save.status, 200);
    const updated = await read();
    assert.deepEqual(JSON.parse(Buffer.from(updated.split('.')[0], 'base64url')).permissions, ['operation.floor.1']);
    assert.notEqual(updated, refreshed);
  } finally {
    child.kill();
    await exited;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('real /me signs configured permission options for non-floor enterprise MCPs', { timeout: 20_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lfclaw-mcp-generic-permissions-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const employee = {
    id: 'internal',
    employeeId: 'staff',
    employeeName: 'Test',
    activationCode: 'TEST',
    status: 'active',
    allowedMcpServerIds: ['inventory-mcp'],
    mcpPermissionGrants: { 'inventory-mcp': ['inventory.read'] },
  };
  await fs.writeFile(path.join(directory, 'enterprise-data.json'), JSON.stringify({
    permissionAssignmentMode: 'employee-only-v1',
    employees: [employee],
    mcpServers: [{
      id: 'inventory-mcp',
      name: 'Inventory MCP',
      transportType: 'sse',
      url: 'http://127.0.0.1/inventory/sse',
      permissionOptions: [
        { id: 'inventory.read', name: 'Read inventory' },
        { id: 'inventory.write', name: 'Write inventory' },
      ],
    }],
    sessions: { 'test-session': { activationCode: 'TEST', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() } },
  }));
  const child = spawn(process.execPath, ['enterprise-server/server.mjs'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LFCLAW_ENTERPRISE_HOST: '127.0.0.1',
      LFCLAW_ENTERPRISE_PORT: String(port),
      LFCLAW_ENTERPRISE_DATA: path.join(directory, 'enterprise-data.json'),
      LFCLAW_ENTERPRISE_DATA_DIR: directory,
      LFCLAW_ENTERPRISE_STORAGE: directory,
      LFCLAW_ENTERPRISE_RELEASE_DIR: directory,
      LFCLAW_ADMIN_TOKEN: 'test-admin',
      LFCLAW_MCP_PERMISSION_SECRET: 'test-secret',
      LFCLAW_MCP_PERMISSION_TTL_MS: String(10 * 60 * 1000),
    },
  });
  const exited = once(child, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test enterprise server did not start')), 10_000);
      child.stdout.on('data', data => { if (data.toString().includes('listening at')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/enterprise/me`, { headers: { authorization: 'Bearer test-session' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    const mcp = body.data.policy.mcpServers[0];
    const assertion = mcp.headers['x-lfclaw-permission-assertion'];
    const payload = JSON.parse(Buffer.from(assertion.split('.')[0], 'base64url'));
    assert.equal(payload.mcp, 'inventory-mcp');
    assert.deepEqual(payload.permissions, ['inventory.read']);
    assert.ok(payload.exp - Math.floor(Date.now() / 1000) <= 10 * 60);
  } finally {
    child.kill();
    await exited;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
