# LfClaw Enterprise Server

这是 LfClaw 的企业管理服务，用于统一管理员工激活码、模型、MCP、技能包、积分和用量。

## 1. 启动命令

本地调试：

```bash
LFCLAW_ENTERPRISE_HOST=127.0.0.1 \
LFCLAW_ENTERPRISE_PORT=8787 \
LFCLAW_ADMIN_TOKEN='lfclaw@123456' \
node enterprise-server/server.mjs
```

服务器启动：

```bash
LFCLAW_ENTERPRISE_HOST=0.0.0.0 \
LFCLAW_ENTERPRISE_PORT=8787 \
LFCLAW_ADMIN_TOKEN='请改成强密码' \
LFCLAW_ENTERPRISE_DATA=/opt/LfClaw/data/enterprise-data.json \
node /opt/LfClaw/enterprise-server/server.mjs
```

## 2. 访问地址

管理后台：

```text
http://服务器IP:8787/admin
```

客户端企业服务地址：

```text
http://服务器IP:8787
```

## 3. 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LFCLAW_ENTERPRISE_HOST` | `127.0.0.1` | 监听地址。服务器部署用 `0.0.0.0` |
| `LFCLAW_ENTERPRISE_PORT` | `8787` | 服务端口 |
| `LFCLAW_ADMIN_TOKEN` | `lfclaw-admin` | 管理后台 Token |
| `LFCLAW_ENTERPRISE_DATA` | `enterprise-server/enterprise-data.json` | 企业数据文件路径 |

生产环境必须显式设置：

```bash
LFCLAW_ENTERPRISE_DATA=/opt/LfClaw/data/enterprise-data.json
```

## 4. 推荐服务器目录

```text
/opt/LfClaw/
├── enterprise-server/
│   ├── server.mjs
│   └── README.md
├── data/
│   └── enterprise-data.json
├── restart.sh
└── server.log
```

代码更新只覆盖：

```text
/opt/LfClaw/enterprise-server/server.mjs
```

不要覆盖：

```text
/opt/LfClaw/data/enterprise-data.json
```

## 5. restart.sh 示例

```bash
#!/usr/bin/env bash
set -e

cd /opt/LfClaw

pkill -f '/opt/LfClaw/enterprise-server/server.mjs' || true

nohup env \
  LFCLAW_ENTERPRISE_HOST=0.0.0.0 \
  LFCLAW_ENTERPRISE_PORT=8787 \
  LFCLAW_ADMIN_TOKEN='请改成强密码' \
  LFCLAW_ENTERPRISE_DATA=/opt/LfClaw/data/enterprise-data.json \
  node /opt/LfClaw/enterprise-server/server.mjs \
  > /opt/LfClaw/server.log 2>&1 &

echo "LfClaw enterprise server restarted."
```

授权：

```bash
chmod +x /opt/LfClaw/restart.sh
```

重启：

```bash
/opt/LfClaw/restart.sh
```

查看日志：

```bash
tail -f /opt/LfClaw/server.log
```

## 6. 后台配置顺序

1. 配置模型。
2. 配置 MCP。
3. 上传技能包。
4. 添加员工并生成激活码。
5. 给员工分配积分、模型、MCP、技能。
6. 员工客户端激活。
7. 在用量监控查看每天消耗。

## 7. 模型计费

模型按服务商真实 token 用量计费。字段含义：

- 输入价格 / 100万 token
- 输出价格 / 100万 token
- 缓存写入 / 100万 token
- 缓存读取 / 100万 token
- 1 货币单位 = 企业积分

积分公式：

```text
积分 = max(
  最低扣费积分,
  固定积分/次
  + ((输入token × 输入价格
    + 输出token × 输出价格
    + 缓存写入token × 缓存写入价格
    + 缓存读取token × 缓存读取价格) / 1000000)
    × 积分换算比例
)
```

试运行建议：

```text
1 元 = 10 积分
```

## 8. API 概览

客户端接口：

- `POST /api/enterprise/activate`
- `GET /api/enterprise/me`
- `GET /api/enterprise/skills/:id/download`
- `POST /api/enterprise/usage`

管理接口：

- `GET /api/admin/state`
- `GET /api/admin/pinyin`
- `POST /api/admin/model-providers`
- `DELETE /api/admin/model-providers/:id`
- `POST /api/admin/mcp`
- `DELETE /api/admin/mcp/:id`
- `POST /api/admin/skills`
- `POST /api/admin/skills/upload`
- `DELETE /api/admin/skills/:id`
- `POST /api/admin/employees`
- `PATCH /api/admin/employees/:activationCode`
- `DELETE /api/admin/employees/:activationCode`

所有管理接口都需要：

```text
Authorization: Bearer 管理员Token
```

## 9. 注意事项

- 不要把真实 API Key 提交到 Git。
- 不要把 `enterprise-data.json` 提交到 Git。
- 编辑模型时，API Key 留空表示不修改原 Key。
- 删除模型、MCP、技能时，会同步移除员工授权。
- 取消员工 MCP 授权后，客户端会清理 OpenClaw 网关里的 MCP 工具。
- 修改计费倍率不会自动重算历史用量。
