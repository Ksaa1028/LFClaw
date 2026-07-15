# LfClaw Enterprise Server

Lightweight enterprise control server for local/LAN validation.

## Start

```bash
node enterprise-server/server.mjs
```

Environment variables:

- `LFCLAW_ENTERPRISE_HOST`, default `127.0.0.1`
- `LFCLAW_ENTERPRISE_PORT`, default `8787`
- `LFCLAW_ADMIN_TOKEN`, default `lfclaw-admin`
- `LFCLAW_ENTERPRISE_DATA`, default `enterprise-server/enterprise-data.json`

Admin URL:

```text
http://127.0.0.1:8787/admin
```

Client enterprise server URL:

```text
http://127.0.0.1:8787
```

## Client APIs

- `POST /api/enterprise/activate`
- `GET /api/enterprise/me`

Admin APIs:

- `GET /api/admin/activations`
- `POST /api/admin/activations`
- `PATCH /api/admin/activations/:code`
- `DELETE /api/admin/activations/:code`
