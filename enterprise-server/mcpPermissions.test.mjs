import assert from 'node:assert/strict';
import test from 'node:test';

import {
  effectiveMcpPermissionIds,
  normalizeMcpPermissionGrants,
  normalizePermissionOptions,
  signMcpPermissionAssertion,
} from './mcpPermissions.mjs';

const mcp = {
  id: 'operations',
  permissionOptions: [
    { id: 'operation.floor.1', name: '营运一层' },
    { id: 'operation.floor.2', name: '营运二层' },
  ],
};
const chain = (data, id) => data.departments.filter(item => item.id === id);

test('normalizes and deduplicates permission definitions', () => {
  assert.deepEqual(normalizePermissionOptions(['a', { id: 'a' }, { id: 'b', name: 'B' }]), [
    { id: 'a', name: 'a', description: '' },
    { id: 'b', name: 'B', description: '' },
  ]);
  assert.deepEqual(normalizeMcpPermissionGrants({ operations: ['a', 'a', 'b'] }), { operations: ['a', 'b'] });
});

test('legacy MCP grants default to every fine-grained permission', () => {
  const employee = { allowedMcpServerIds: ['operations'] };
  assert.deepEqual(effectiveMcpPermissionIds({ departments: [] }, employee, mcp, chain), [
    'operation.floor.1',
    'operation.floor.2',
  ]);
});

test('explicit employee permissions can select multiple values', () => {
  const employee = {
    allowedMcpServerIds: ['operations'],
    mcpPermissionGrants: { operations: ['operation.floor.2'] },
  };
  assert.deepEqual(effectiveMcpPermissionIds({ departments: [] }, employee, mcp, chain), ['operation.floor.2']);
});

test('employee selection overrides broader department permissions', () => {
  const departmentMcp = { id: 'operations', permissionOptions: mcp.permissionOptions };
  const employee = {
    departmentId: 'sales',
    mcpPermissionGrants: { operations: ['operation.floor.2'] },
  };
  const departments = [{
    id: 'sales',
    allowedMcpServerIds: ['operations'],
  }];
  assert.deepEqual(
    effectiveMcpPermissionIds({ departments }, employee, departmentMcp, () => departments),
    ['operation.floor.2'],
  );
});

test('signs a stable HMAC assertion without exposing the secret', () => {
  const assertion = signMcpPermissionAssertion({
    secret: 'test-secret',
    employeeId: 'employee-1',
    mcpId: 'operations',
    permissionIds: ['operation.floor.1'],
    now: 1_700_000_000_000,
  });
  assert.match(assertion, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(assertion.includes('test-secret'), false);
});
