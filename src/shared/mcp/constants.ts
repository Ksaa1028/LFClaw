export const McpIpcChannel = {
  List: 'mcp:list',
  Create: 'mcp:create',
  Update: 'mcp:update',
  Delete: 'mcp:delete',
  DeleteByRegistryId: 'mcp:deleteByRegistryId',
  SetEnabled: 'mcp:setEnabled',
  SetEnabledByRegistryId: 'mcp:setEnabledByRegistryId',
  RetryLaunchResolution: 'mcp:retryLaunchResolution',
  FetchMarketplace: 'mcp:fetchMarketplace',
  ConnectQichacha: 'mcp:qichachaConnect',
  Changed: 'mcp:changed',
} as const;
export type McpIpcChannel = typeof McpIpcChannel[keyof typeof McpIpcChannel];

export const McpTimeout = {
  ConnectionMs: 45_000,
  RequestMs: 180_000,
} as const;
