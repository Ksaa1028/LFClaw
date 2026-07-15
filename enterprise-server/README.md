# LfClaw Enterprise Server

LfClaw 企业服务用于统一管理员工激活码、模型、MCP、技能包、积分、用量和客户端更新源。客户端仍然使用本机 OpenClaw 网关，但授权、模型配置、MCP、技能和积分由企业服务实时控制。

## 1. 代码仓库

二开代码仓库：

```bash
git clone https://git.code.tencent.com/tongkai/LfClaw.git
cd LfClaw
```

后续跑通验证过的代码推送到：

```text
https://git.code.tencent.com/tongkai/LfClaw.git
```

## 2. 推荐服务器目录

生产环境建议固定放在：

```text
/opt/LfClaw/
├── enterprise-server/
│   ├── server.mjs
│   └── README.md
├── data/
│   ├── enterprise-data.json
│   └── backups/
├── storage/
│   └── skills/
├── restart.sh
└── server.log
```

只更新服务端代码时，覆盖：

```text
/opt/LfClaw/enterprise-server/server.mjs
```

不要覆盖：

```text
/opt/LfClaw/data/enterprise-data.json
/opt/LfClaw/data/backups/
/opt/LfClaw/storage/
```

## 3. 启动服务

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
LFCLAW_ENTERPRISE_DATA_DIR=/opt/LfClaw/data \
LFCLAW_ENTERPRISE_STORAGE=/opt/LfClaw/storage \
node /opt/LfClaw/enterprise-server/server.mjs
```

管理后台：

```text
http://服务器IP:8787/admin
```

客户端企业服务地址：

```text
http://服务器IP:8787
```

## 4. restart.sh

建议创建：

```text
/opt/LfClaw/restart.sh
```

内容：

```bash
#!/usr/bin/env bash
set -e

cd /opt/LfClaw

pkill -f '/opt/LfClaw/enterprise-server/server.mjs' || true

nohup env \
  LFCLAW_ENTERPRISE_HOST=0.0.0.0 \
  LFCLAW_ENTERPRISE_PORT=8787 \
  LFCLAW_ADMIN_TOKEN='请改成强密码' \
  LFCLAW_ENTERPRISE_DATA_DIR=/opt/LfClaw/data \
  LFCLAW_ENTERPRISE_STORAGE=/opt/LfClaw/storage \
  node /opt/LfClaw/enterprise-server/server.mjs \
  > /opt/LfClaw/server.log 2>&1 &

echo "LfClaw enterprise server restarted."
```

授权并重启：

```bash
chmod +x /opt/LfClaw/restart.sh
/opt/LfClaw/restart.sh
```

查看日志：

```bash
tail -f /opt/LfClaw/server.log
```

## 5. 后台使用顺序

1. 打开 `/admin`，输入管理员 Token。
2. 在“模型配置”里添加模型，填写 Base URL、API Key、token 价格和积分换算。
3. 在“MCP 服务”里添加 SSE、Streamable HTTP、HTTP 或 stdio MCP。
4. 在“技能包”里上传技能 zip。
5. 在“员工与激活码”里添加员工，分配积分、模型、MCP 和技能。
6. 员工客户端输入激活码。
7. 在“用量监控”里查看每天员工、模型、token、积分和折算金额。
8. 在“数据备份”里手动创建备份或导出当前数据。
9. 在“版本更新”里维护客户端最新版本、下载地址和更新日志。

## 6. 技能包闭环

技能包流程：

```text
后台上传 zip
→ 服务端保存到 /opt/LfClaw/storage/skills
→ 员工授权技能
→ 客户端同步策略并下载 zip
→ 客户端安装到本机技能目录
→ 取消员工授权
→ 客户端下次同步后移除企业下发技能
```

注意：

- 删除后台技能时，会同步移除员工身上的该技能授权。
- 删除后台技能时，会清理对应的服务端 zip 文件。
- 客户端只会自动移除“企业服务下发并记录过”的技能，避免误删用户自己安装的技能。

## 7. 数据备份

后台“数据备份”提供两个动作：

- 创建备份：复制当前企业数据到 `/opt/LfClaw/data/backups/`。
- 导出当前数据：下载当前 `enterprise-data.json`。

更新 `server.mjs` 不会覆盖 `/opt/LfClaw/data`，所以正常升级服务端不会丢员工、模型、MCP、技能和用量数据。

## 8. 企业更新源

后台“版本更新”维护以下字段：

- 最新版本，例如 `2026.7.16`
- 发布日期
- Windows x64 下载地址，建议是 `.exe`
- macOS Apple Silicon 下载地址，建议是 `.dmg`
- macOS Intel 下载地址，建议是 `.dmg`
- 通用下载页
- 中文更新日志
- 英文更新日志

客户端激活企业服务后，更新检查优先访问：

```text
GET /api/enterprise/update
GET /api/enterprise/update-manual
```

返回格式兼容当前客户端更新模块。客户端会根据当前系统选择 Windows 或 macOS 下载地址。

## 9. 打包命令

Windows：

```bash
npm run dist:win
```

macOS Apple Silicon：

```bash
npm run dist:mac:arm64
```

macOS Intel：

```bash
npm run dist:mac:x64
```

macOS 后续必须重点验证：

- 应用签名
- 公证
- OpenClaw runtime 是否随包可用
- 企业激活
- 企业更新源检测
- 下载并安装更新

## 10. API 概览

客户端接口：

- `POST /api/enterprise/activate`
- `GET /api/enterprise/me`
- `GET /api/enterprise/skills/:id/download`
- `POST /api/enterprise/usage`
- `GET /api/enterprise/update`
- `GET /api/enterprise/update-manual`

管理接口：

- `GET /api/admin/state`
- `GET /api/admin/export`
- `GET /api/admin/backups`
- `POST /api/admin/backups`
- `GET /api/admin/backups/:name/download`
- `POST /api/admin/release`
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

## 11. 重要规则

- 不要把真实 API Key 提交到 Git。
- 不要把 `enterprise-data.json` 提交到 Git。
- 模型价格变化后，历史用量默认不重算；只影响后续新调用。
- 删除模型、MCP、技能时，会同步移除员工授权。
- 生产更新前，先在后台“数据备份”创建备份。
