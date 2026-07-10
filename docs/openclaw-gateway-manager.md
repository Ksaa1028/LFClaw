# OpenClaw Gateway Manager

This service is the multi-user front door for remote OpenClaw.

It exposes one public HTTP/WS port and keeps per-user OpenClaw gateways bound to
`127.0.0.1` only.

## Endpoints

- `GET /health`
- `GET /api/openclaw/gateway-token`
- `WS /gateway/:leaseId`

The token endpoint expects the existing LobsterAI login token:

```http
Authorization: Bearer <lobsterai-access-token>
```

It validates the token against:

```text
https://lobsterai-server.youdao.com/api/user/profile
```

Then it creates or reuses a per-user OpenClaw state directory and returns:

```json
{
  "code": 0,
  "data": {
    "gatewayUrl": "ws://8.216.38.213:18791/gateway/<leaseId>",
    "token": "<openclaw-gateway-token>",
    "model": "zai/glm-5.2",
    "allowInsecurePrivateWs": true,
    "expiresAt": "2026-07-03T08:00:00.000Z"
  }
}
```

## Server Install

Copy files:

```bash
mkdir -p /opt/lobsterai-gateway-manager
cp scripts/openclaw-gateway-manager.cjs /opt/lobsterai-gateway-manager/
cp deploy/systemd/lobsterai-gateway-manager.service /etc/systemd/system/
```

Create the data root:

```bash
mkdir -p /opt/lobsterai-gateway-manager/users
```

Make sure `openclaw` is on PATH and that this template config exists:

```bash
openclaw models status
test -f /root/.openclaw/openclaw.json
```

Start:

```bash
systemctl daemon-reload
systemctl enable --now lobsterai-gateway-manager
systemctl status lobsterai-gateway-manager
```

Open the public port:

```bash
ufw allow 18791/tcp
```

Or for Alibaba Cloud security group, allow TCP `18791`.

## Environment

| Variable | Default |
| --- | --- |
| `LOBSTERAI_GATEWAY_MANAGER_HOST` | `0.0.0.0` |
| `LOBSTERAI_GATEWAY_MANAGER_PORT` | `18791` |
| `LOBSTERAI_GATEWAY_MANAGER_PUBLIC_BASE_URL` | `http://8.216.38.213:18791` |
| `LOBSTERAI_SERVER_BASE_URL` | `https://lobsterai-server.youdao.com` |
| `OPENCLAW_BIN` | `openclaw` |
| `LOBSTERAI_GATEWAY_MANAGER_DATA_ROOT` | `/opt/lobsterai-gateway-manager` |
| `LOBSTERAI_OPENCLAW_TEMPLATE_CONFIG` | `/root/.openclaw/openclaw.json` |
| `LOBSTERAI_OPENCLAW_MODEL` | `zai/glm-5.2` |
| `LOBSTERAI_OPENCLAW_PORT_START` | `19001` |
| `LOBSTERAI_OPENCLAW_PORT_END` | `19999` |
| `LOBSTERAI_OPENCLAW_IDLE_MS` | `1800000` |

## Notes

- Keep current `18790` as the single-user fallback gateway for now.
- Public clients should move to `18791` after the client supports full gateway
  config returned by `/api/openclaw/gateway-token`.
- Without a domain, this is `http/ws` and should be treated as internal testing.
  Move to `https/wss` when a domain or TLS front door is available.

