# MCP timeout and recovery patches

`openclaw-mcp-stale-connection-recovery.patch` reconnects after a failed
request without replaying that request (tools may have side effects).

`openclaw-mcp-stale-request-backoff.patch` preserves the existing repeated-request
failure protection across reconnects. Only a successful request clears failures;
the existing temporary cooldown never removes a conversation or its history.

`openclaw-mcp-timeout-and-catalog-retry.patch` applies after it. It raises
the native discovery budget from 1.5 to 30 seconds, caps discovery separately
from tool calls, and prevents failed discovery from being cached indefinitely.
These changes require a runtime patch because the discovery cache and its
timeout selection are internal to OpenClaw. LobsterAI config sync separately
sets 45-second connection and 180-second tool request limits.

Release builds always enter the fingerprint-aware runtime pipeline. The pack
hook rejects stale version/patch metadata and bundles missing recovery code.
The source patch validator also fails closed when application is ambiguous.

Validation: `node scripts/smoke-openclaw-mcp-recovery.cjs` reads the pinned
sibling checkout (or `OPENCLAW_SRC`) and applies the patches in memory. It uses
real MCP SDK HTTP transports on loopback to test slow discovery, invalidated
server sessions, repeated offline requests, timeouts, and same-session recovery
without replay. It does not rebuild the runtime or change user data. The final
installer still needs a rebuilt runtime and packaged-app acceptance testing.
