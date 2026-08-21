import crypto from 'crypto';

const asList = value => Array.isArray(value) ? value : [];

export const normalizePermissionOptions = value => {
  const seen = new Set();
  return asList(value).flatMap(item => {
    const source = typeof item === 'string' ? { id: item, name: item } : item;
    if (!source || typeof source !== 'object') return [];
    const id = String(source.id || '').trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      name: String(source.name || id).trim() || id,
      description: String(source.description || '').trim(),
    }];
  });
};

export const normalizeMcpPermissionGrants = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([mcpId, permissionIds]) => [
    String(mcpId),
    [...new Set(asList(permissionIds).map(id => String(id).trim()).filter(Boolean))],
  ]));
};

export const permissionOptionIds = mcp => normalizePermissionOptions(mcp?.permissionOptions).map(item => item.id);

const directPermissionIds = (subject, mcp) => {
  const grants = normalizeMcpPermissionGrants(subject?.mcpPermissionGrants);
  if (Object.prototype.hasOwnProperty.call(grants, mcp.id)) {
    const valid = new Set(permissionOptionIds(mcp));
    return grants[mcp.id].filter(id => valid.has(id));
  }
  // Existing enterprise data had only MCP-level grants. Treat it as full
  // permission so enabling fine-grained permissions never removes old access.
  return permissionOptionIds(mcp);
};

export const effectiveMcpPermissionIds = (_data, employee, mcp, _departmentChain) => {
  const options = permissionOptionIds(mcp);
  if (options.length === 0) return [];
  const employeeGrants = normalizeMcpPermissionGrants(employee?.mcpPermissionGrants);
  // A saved employee selection is an explicit personal override. This lets
  // two employees in the same department have different floor permissions.
  if (Object.prototype.hasOwnProperty.call(employeeGrants, mcp.id)) {
    const valid = new Set(options);
    return employeeGrants[mcp.id].filter(id => valid.has(id));
  }
  if (!asList(employee?.allowedMcpServerIds).includes(mcp.id)) return [];
  return directPermissionIds(employee, mcp);
};

const base64Url = value => Buffer.from(value).toString('base64url');

export const signMcpPermissionAssertion = ({ secret, employeeId, mcpId, permissionIds, now = Date.now(), ttlMs = 24 * 60 * 60 * 1000 }) => {
  if (!secret) return '';
  const payload = base64Url(JSON.stringify({
    sub: String(employeeId || ''),
    mcp: String(mcpId || ''),
    permissions: [...new Set(asList(permissionIds).map(String))],
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
  }));
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};
