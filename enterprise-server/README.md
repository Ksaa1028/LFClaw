# LfClaw Enterprise Server

## 兜知2.0 员工楼层权限

楼层权限只绑定企业 MCP `dz2.0`。其他 MCP 不启用、也不显示楼层权限。

- 默认使用内置兼容配置，无需额外设置环境变量；需要多套环境隔离时才用 `LFCLAW_MCP_PERMISSION_SECRET` 覆盖默认值。
- 员工新增/编辑页面固定显示营运一层、二层、三层、四层和营运自营五项权限。
- 每名员工可独立多选；个人选择优先于部门继承权限。
- 历史员工/部门只有 MCP 授权、没有细分记录时，自动视为五项全选，兼容旧数据。
- LFCLAW 下发短期 HMAC 签名请求头，MCP 服务验签后再限制楼层；签名缺失或无效不会走新权限路径。

管理接口：`PATCH /api/admin/mcp/:id/permission-assignments`。

LfClaw 企业服务用于统一管理员工激活码、模型、MCP、技能包、积分、用量和客户端更新源。客户端仍然使用本机 OpenClaw 网关，但授权、模型配置、MCP、技能和积分由企业服务实时控制。

## 部门树与授权范围

服务端支持树级部门和单部门员工归属。历史数据无需迁移：缺少 `departments` 和
`departmentId` 的旧数据会按“无部门”读取，员工已有的个人授权保持不变。

- 部门保存在顶层 `departments` 数组，通过 `parentId` 组成树；根部门的 `parentId` 为空字符串。
- 员工通过 `departmentId` 绑定一个部门。
- 员工有效授权为个人授权、所在部门授权及所有上级部门授权的并集。
- 客户端激活和 `/api/enterprise/me` 的响应结构不变，只会收到合并后的最终权限。
- 删除仍有下级部门或员工的部门会返回 `409`，避免意外解绑。

管理员接口：

```text
POST   /api/admin/departments
PATCH  /api/admin/departments/:departmentId
DELETE /api/admin/departments/:departmentId
PATCH  /api/admin/employees/:activationCode
PATCH  /api/admin/model-providers/:id/assignments
PATCH  /api/admin/mcp/:id/assignments
PATCH  /api/admin/skills/:id/assignments
```

创建或修改部门时提交 `name`、`parentId`。修改员工时提交 `departmentId` 即可绑定或移动部门，
提交空字符串可移出部门。资源分配接口同时接收 `departmentIds` 和 `activationCodes`。

管理后台 `/admin` 的“部门管理”页只维护部门树；模型、MCP、技能各自的“分配范围”页面可选择整个部门或部门下的具体人员。

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
│   ├── mcpPermissions.mjs
│   ├── package.json
│   └── README.md
├── data/
│   ├── enterprise-data.json
│   └── backups/
├── storage/
│   └── skills/
├── restart.sh
└── server.log
```

本次楼层权限改造更新服务端代码时，覆盖：

```text
/opt/LfClaw/enterprise-server/server.mjs
/opt/LfClaw/enterprise-server/mcpPermissions.mjs
/opt/LfClaw/enterprise-server/package.json
```

随后在 `/opt/LfClaw/enterprise-server` 执行 `npm install --omit=dev` 并重启企业服务。不要只上传 `server.mjs`，否则楼层权限模块会缺失。

不要覆盖：

```text
/opt/LfClaw/data/enterprise-data.json
/opt/LfClaw/data/backups/
/opt/LfClaw/storage/
```

## 3. 启动服务

企业服务现在依赖 `ws` 做语音识别 WebSocket 代理。首次部署或更新到包含语音识别能力的版本后，需要在企业服务目录安装依赖：

```bash
cd /opt/LfClaw/enterprise-server
npm install --omit=dev
```

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

## 6.1 语音识别配置

语音输入是企业全局能力，不按员工单独授权。所有已激活员工都可以使用，客户端只拿临时代理地址，阿里云 API Key 只保存在企业服务端。

阿里云百炼实时语音识别推荐配置：

```text
显示名称：阿里云实时语音识别
Workspace ID：填写百炼业务空间 ID，例如 llm-xxxx
地域：cn-beijing
模型：fun-asr-realtime
API Host：填写百炼业务空间域名，例如 llm-xxxx.cn-beijing.maas.aliyuncs.com
WebSocket URL：留空，服务端会自动按 Workspace ID 和地域生成
API Key：填写百炼 API Key
音频格式：pcm
采样率：16000
分片间隔(ms)：200
单次最长录音(s)：60
价格备注：可选
```

保存后，后台状态显示“已配置”即可。客户端完成企业激活后会自动同步语音策略；如果刚保存完配置，建议重启客户端或等待下一次策略同步后再测试麦克风。

部署注意：

- 如果服务器提示 `Cannot find package 'ws'` 或 `Could not read package.json`，请确认 `/opt/LfClaw/enterprise-server/package.json` 已上传，并在 `/opt/LfClaw/enterprise-server` 下执行 `npm install --omit=dev`。
- 不要在 `/opt/LfClaw` 根目录执行 `npm install`，根目录不需要 `package.json`。
- 更新 `server.mjs` 不会覆盖 `/opt/LfClaw/data/enterprise-data.json`，语音配置会随企业数据保存在 data 目录。

2026-07-22 验证结论：

- 语音输入走企业服务统一配置，不需要给每个员工单独授权。
- 客户端只读取企业服务下发的临时语音会话，不在本地保存阿里云 API Key。
- 服务端配置保存后，只要企业服务已重启并能访问阿里云实时语音识别 WebSocket，客户端无需重新打包即可生效。
- 当前建议使用 `pcm`、`16000` 采样率、`200ms` 分片间隔，先保证链路稳定，再考虑更多格式。
- 如果客户端提示“语音识别服务暂不可用”，先看企业服务日志，再检查 API Key、Workspace ID、地域、API Host 和 `ws` 依赖。

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

后台“版本更新”默认不需要手动填写。企业服务会自动扫描 `/opt/LfClaw/releases`，取文件名中最大的日期流水号作为最新版。

客户端激活企业服务后，更新检查优先访问：

```text
GET /api/enterprise/update
GET /api/enterprise/update-manual
```

返回格式兼容当前客户端更新模块。客户端会根据当前系统选择 Windows 或 macOS 下载地址。

从 `2026071603` 版本开始，更新接口会同时返回安装包大小和 SHA256。客户端下载完成后会校验文件大小、哈希和 Windows 安装包文件头，避免不完整安装包触发 NSIS integrity check 错误。

安装包直接放在企业服务目录：

```bash
mkdir -p /opt/LfClaw/releases
cp LFClaw-Setup-2026071501-win-x64-official.exe /opt/LfClaw/releases/
```

后台下载地址填写：
不用手动填写。服务会自动生成 `http://服务器IP:8787/releases/文件名`。

注意：Linux 区分大小写，服务器上的文件名必须和更新接口返回的文件名完全一致，例如 `LFClaw-Setup-2026071603-win-x64-official.exe`。

更新日志放同一目录，推荐命名：

```text
changelog-2026071501.zh.txt
changelog-2026071501.en.txt
```

每行一条更新内容。没有英文日志时会自动复用中文日志。

如果需要独立存放安装包目录，可以启动服务时设置：

```bash
LFCLAW_ENTERPRISE_RELEASE_DIR=/opt/LfClaw/releases
```

## 9. 打包命令

Windows 日常更新包只用这一条：

```bash
npm run release:win
```

Windows 开发机推荐直接双击仓库根目录的 `发布Windows安装包.cmd`。脚本会自动检查 Node 24.15.0+、关闭当前仓库残留的开发进程、复用本地 Electron 运行时并完成正式发布，不需要手工输入命令。

Windows 和 macOS 的发布命令都会自动完成：

- 生成当天版本号。
- 生成更新日志。
- 构建前端和 Electron 主进程。
- 构建技能依赖。
- 构建或复用对应平台的 OpenClaw runtime。
- 打对应平台安装包。
- 校验安装包、版本号和更新日志是否都存在。

版本号规则是 `YYYYMMDDNN`。如果当天已有 `2026071501`、`2026071502`，再次运行会自动生成 `2026071503`。

如果要手动指定当天第几版：

```bash
LFCLAW_BUILD_SEQ=3 npm run release:win
```

也可以直接指定完整版本：

```bash
LFCLAW_BUILD_VERSION=2026071503 npm run release:win
```

如果要手动写更新日志：

```bash
LFCLAW_CHANGELOG="隐藏旧协议弹窗；去掉广告；优化设置入口" npm run release:win
```

只有改了 OpenClaw runtime、底层网关、内置依赖时，才跑完整运行时打包：

```bash
npm run release:win:runtime
```

macOS 必须在 Mac 电脑上打包。Mac 电脑拉取 Git 代码后运行：

```bash
npm run release:mac:arm64
npm run release:mac:x64
```

如果要让 macOS 包和 Windows 包使用同一个版本号，需要显式指定同一个版本：

```bash
LFCLAW_BUILD_VERSION=2026071601 npm run release:mac:arm64
LFCLAW_BUILD_VERSION=2026071601 npm run release:mac:x64
```

macOS 改了 OpenClaw runtime、底层网关、内置依赖时，才跑：

```bash
npm run release:mac:arm64:runtime
npm run release:mac:x64:runtime
```

打包完成后，上传到服务器：

```bash
scp release/LFClaw-Setup-2026071503-win-x64-official.exe root@服务器IP:/opt/LfClaw/releases/
scp release/LFClaw-2026071503-mac-arm64-official.dmg root@服务器IP:/opt/LfClaw/releases/
scp release/LFClaw-2026071503-mac-x64-official.dmg root@服务器IP:/opt/LfClaw/releases/
scp release/changelog-2026071503.zh.txt root@服务器IP:/opt/LfClaw/releases/
```

如果本次改动包含企业服务更新源逻辑，必须同时上传最新的 `enterprise-server/server.mjs` 并重启企业服务。否则客户端可能拿不到安装包大小和 SHA256，更新校验能力不会生效。

推荐上传后先验证：

```bash
curl "http://服务器IP:8787/api/enterprise/update?version=旧版本号"
curl -I "http://服务器IP:8787/releases/LFClaw-Setup-版本号-win-x64-official.exe"
```

检查更新 JSON 中应包含 `size` 和 `sha256`，`curl -I` 应返回正确的 `Content-Length`。

macOS 首次发版必须重点验证：

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
- `POST /api/enterprise/asr/realtime/sessions`
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
- `POST /api/admin/asr`
- `GET /api/admin/pinyin`
- `POST /api/admin/model-providers`
- `DELETE /api/admin/model-providers/:id`
- `POST /api/admin/mcp`
- `PATCH /api/admin/mcp/:id/permission-assignments`
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
