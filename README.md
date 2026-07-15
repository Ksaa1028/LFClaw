# LfClaw 企业 AI 平台

LfClaw 是基于 LobsterAI / OpenClaw 二开的企业内部 AI 桌面客户端与企业管理服务。目标是让企业管理员统一配置模型、MCP、技能包、员工激活码和积分额度，员工在本机客户端激活后使用企业授权能力。

本文档按“从 0 到 1”写，适合新机器、新服务器、新同事直接照着部署和启动。

## 1. 当前架构

LfClaw 分为两部分：

- 企业管理服务：Node.js 单文件服务，提供管理后台、员工激活、模型配置、MCP 配置、技能包上传、积分和用量统计。
- 桌面客户端：Electron + React 客户端，员工本机运行，使用本机 OpenClaw 网关，但模型、MCP、技能、积分和激活状态受企业服务控制。

运行关系：

```text
企业管理员浏览器
        |
        v
企业管理服务 /admin
        |
        | 激活码、模型、MCP、技能、积分策略
        v
LfClaw 桌面客户端
        |
        | 本机 OpenClaw 网关
        v
模型服务商 / MCP 服务 / 本地技能
```

## 2. 代码仓库

当前二开仓库：

```bash
git clone https://git.code.tencent.com/tongkai/LfClaw.git
cd LfClaw
```

如果本地已经从上游有道仓库拉过代码，可以增加腾讯仓库远程：

```bash
git remote add tencent https://git.code.tencent.com/tongkai/LfClaw.git
git fetch tencent
```

以后验证通过的代码推送到腾讯仓库：

```bash
git add .
git commit -m "fix(enterprise): your change summary"
git push tencent main
```

## 3. 环境要求

推荐环境：

- Windows 10/11 用于开发和运行桌面客户端
- Linux 服务器用于企业管理服务
- Node.js `>=24.15.0 <25`
- Git

本项目在 Windows 开发时建议使用 Node 24。仓库里 Electron、OpenClaw、better-sqlite3 等依赖对 Node/Electron ABI 比较敏感，Node 版本不一致时可能出现本地模块加载失败。

## 4. 安装依赖

在项目根目录执行：

```bash
npm install
```

如果 Windows 上依赖安装失败，可以先确认 Node 版本：

```bash
node -v
npm -v
```

如果 Electron 依赖或 SQLite 原生模块异常，可尝试：

```bash
npm rebuild
```

## 5. 企业管理服务本地启动

企业服务入口文件：

```text
enterprise-server/server.mjs
```

本地启动：

```bash
LFCLAW_ENTERPRISE_HOST=127.0.0.1 \
LFCLAW_ENTERPRISE_PORT=8787 \
LFCLAW_ADMIN_TOKEN='lfclaw@123456' \
node enterprise-server/server.mjs
```

Windows PowerShell 写法：

```powershell
$env:LFCLAW_ENTERPRISE_HOST='127.0.0.1'
$env:LFCLAW_ENTERPRISE_PORT='8787'
$env:LFCLAW_ADMIN_TOKEN='lfclaw@123456'
node enterprise-server/server.mjs
```

打开管理后台：

```text
http://127.0.0.1:8787/admin
```

管理员 Token 填：

```text
lfclaw@123456
```

## 6. 企业服务数据目录

企业数据不要放进 Git，也不要跟随 `server.mjs` 覆盖。

推荐服务器目录：

```text
/opt/LfClaw/
├── enterprise-server/
│   ├── server.mjs
│   └── README.md
└── data/
    └── enterprise-data.json
```

推荐设置：

```bash
LFCLAW_ENTERPRISE_DATA=/opt/LfClaw/data/enterprise-data.json
```

这样以后只更新 `enterprise-server/server.mjs`，不会影响真实员工、模型、MCP、技能和用量数据。

## 7. 服务器部署企业服务

在服务器上创建目录：

```bash
sudo mkdir -p /opt/LfClaw/enterprise-server
sudo mkdir -p /opt/LfClaw/data
```

把本地文件上传到服务器：

```text
enterprise-server/server.mjs
enterprise-server/README.md
```

放到：

```text
/opt/LfClaw/enterprise-server/
```

服务器启动命令示例：

```bash
LFCLAW_ENTERPRISE_HOST=0.0.0.0 \
LFCLAW_ENTERPRISE_PORT=8787 \
LFCLAW_ADMIN_TOKEN='lfclaw@123456' \
LFCLAW_ENTERPRISE_DATA=/opt/LfClaw/data/enterprise-data.json \
node /opt/LfClaw/enterprise-server/server.mjs
```

访问地址示例：

```text
http://服务器IP:8787/admin
```

客户端企业服务地址：

```text
http://服务器IP:8787
```

## 8. 简化重启脚本

推荐在服务器创建：

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
  LFCLAW_ADMIN_TOKEN='lfclaw@123456' \
  LFCLAW_ENTERPRISE_DATA=/opt/LfClaw/data/enterprise-data.json \
  node /opt/LfClaw/enterprise-server/server.mjs \
  > /opt/LfClaw/server.log 2>&1 &

echo "LfClaw enterprise server restarted."
```

授权执行：

```bash
chmod +x /opt/LfClaw/restart.sh
```

以后重启：

```bash
/opt/LfClaw/restart.sh
```

查看日志：

```bash
tail -f /opt/LfClaw/server.log
```

## 9. 企业后台使用顺序

建议按这个顺序配置：

1. 打开 `/admin`，输入管理员 Token。
2. 在“模型配置”添加模型。
3. 在“MCP 服务”添加企业 MCP。
4. 在“技能包”上传技能 zip。
5. 在“员工与激活码”添加员工，分配积分、模型、MCP、技能。
6. 员工客户端用激活码激活。
7. 在“用量监控”查看每天的员工、模型、token、积分和折算金额。

## 10. 模型配置说明

模型配置最关键字段：

- 模型 ID：模型真实 ID，例如 `glm-5.2`
- 模型名称：客户端展示名，例如 `智谱 GLM-5.2`
- Base URL：模型服务商 OpenAI 兼容地址，例如 `https://open.bigmodel.cn/api/paas/v4`
- API Key：服务商 Key，只保存在企业数据文件里，不提交 Git
- 输入价格 / 100万 token：按官网价格填
- 输出价格 / 100万 token：按官网价格填
- 缓存写入 / 100万 token：有则填，没有填 0
- 缓存读取 / 100万 token：有则填，没有填 0
- 1 货币单位 = 企业积分：企业内部积分倍率

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

建议积分倍率：

- 试运行严格管理：`1 元 = 10 积分`
- 普通企业内部额度：`1 元 = 5 积分`
- 接近真实成本核算：`1 元 = 1 积分`

当前建议先用：

```text
1 元 = 10 积分
```

注意：修改倍率后，历史用量记录不会自动重算。历史记录按当时规则固定，便于审计。

## 11. MCP 配置说明

MCP 支持：

- SSE
- HTTP / Streamable HTTP
- stdio

常用远程 MCP 字段：

- MCP ID：企业内唯一 ID，例如 `dz2.0`
- 名称：客户端展示名，例如 `兜知2.0`
- 类型：一般远程服务选 `SSE`
- 服务 URL：例如 `https://example.com/sse`
- Headers(JSON)：需要鉴权时填写，例如 `{"Authorization":"Bearer xxx"}`

员工取消 MCP 授权后，客户端会同步企业策略，并清空 OpenClaw 网关里的 MCP 工具列表。新对话不应再能调用已取消授权的 MCP。

## 12. 技能包说明

技能以 zip 包上传到企业后台。管理员上传后，可在员工授权里分配给指定员工。

客户端激活后会根据企业授权下载技能包并安装到本机。

注意：

- 技能包不要直接提交到 Git。
- 企业后台上传的技能包属于运行数据，应保存在服务器 `/opt/LfClaw/data` 或服务配置的数据目录下。

## 13. 员工激活流程

管理员在后台添加员工时填写：

- 中文姓名
- 员工 ID，可自动由中文名转拼音并拼随机码
- 积分额度
- 授权模型
- 授权 MCP
- 授权技能

生成激活码后，员工客户端启动时输入激活码。

客户端会把激活信息存在本机；后续启动会自动同步企业策略。

如果管理员禁用员工激活码，客户端下一次同步或对话前检查时会发现禁用状态，阻止继续使用。

## 14. 桌面客户端本地开发启动

首次需要准备 OpenClaw 运行时：

```bash
npm run electron:dev:openclaw
```

日常开发：

```bash
npm run electron:dev
```

指定远程企业服务地址：

Windows PowerShell：

```powershell
$env:LFCLAW_ENTERPRISE_BASE_URL='http://服务器IP:8787'
npm run electron:dev
```

macOS / Linux：

```bash
LFCLAW_ENTERPRISE_BASE_URL=http://服务器IP:8787 npm run electron:dev
```

客户端启动后：

1. 进入“企业激活”。
2. 输入企业激活码。
3. 激活成功后，侧边栏显示员工中文名。
4. 对话模型列表只显示企业授权模型。
5. MCP 页面只显示企业授权 MCP。
6. 技能页面只显示企业授权技能。

## 15. 打包客户端

Windows：

```bash
npm run dist:win
```

macOS：

```bash
npm run dist:mac
```

Linux：

```bash
npm run dist:linux
```

打包前确保：

- OpenClaw runtime 已构建
- 企业服务地址配置正确
- 图标和名称已经是 LfClaw
- 本地能正常激活、对话、同步模型/MCP/技能

## 16. 更新服务器代码

只更新代码，不覆盖数据：

```bash
cd /opt/LfClaw
cp /path/to/new/server.mjs /opt/LfClaw/enterprise-server/server.mjs
/opt/LfClaw/restart.sh
```

确认服务：

```bash
curl http://127.0.0.1:8787/admin
```

真实数据在：

```text
/opt/LfClaw/data/enterprise-data.json
```

不要用新的空数据文件覆盖它。

## 17. Git 提交流程

每次代码跑通后：

```bash
git status
git add .
git commit -m "fix(enterprise): describe the verified change"
git push tencent main
```

提交前注意不要提交这些文件：

- `enterprise-server/enterprise-data.json`
- `enterprise-server/*.log`
- `enterprise-server/storage/`
- `tmp-enterprise-skill.zip`
- `vite.log`
- 任何真实 API Key

这些已经写入 `.gitignore`。

## 18. 常见问题

### 18.1 客户端提示 API Key 无效或过期

常见原因：

- 模型服务商 Key 真的失效
- 后台编辑模型时误覆盖了 Key
- Base URL 填错
- 模型 ID 填错

当前代码已经避免把 `********` 保存成真实 Key。编辑模型时，如果不想修改 Key，API Key 留空即可。

### 18.2 后台取消 MCP 授权后，客户端仍能调用 MCP

需要确认客户端已同步企业策略，并且 OpenClaw 网关已刷新。

修复后的逻辑：

- 企业授权为空时，本地企业 MCP 会被禁用
- `openclaw.json` 会写入 `mcp.servers: {}`
- 企业策略变化会触发网关重启

如果还遇到，先重启客户端再新建对话验证。

### 18.3 积分消耗看起来很多

模型服务商返回的 token 包含：

- 用户可见输入
- 系统提示词
- 历史上下文
- 工具调用上下文
- 缓存读取 token

所以不是只按你输入的几个字计算。

建议先用 `1 元 = 10 积分`，如果员工感觉扣得快，可以改成 `1 元 = 5 积分`。

### 18.4 修改积分倍率后历史用量没有变化

正常。

历史用量是按当时规则写入的，不会自动重算。这样方便审计。后续如有需要，可以加“按当前价格重算历史用量”的后台按钮。

### 18.5 未检测到内置 AI 引擎运行时

说明 OpenClaw runtime 没构建或没打包进去。

开发环境执行：

```bash
npm run electron:dev:openclaw
```

打包环境确认 `vendor/openclaw-runtime/current` 存在。

## 19. 目录速查

```text
enterprise-server/server.mjs                 企业管理服务
enterprise-server/README.md                  企业服务部署说明
resources/enterprise.json                    客户端默认企业服务配置
src/main/libs/lfclawEnterpriseAccess.ts      客户端企业激活与策略同步
src/renderer/components/enterprise/          企业激活页面
src/main/libs/openclawConfigSync.ts          OpenClaw 配置同步
src/main/main.ts                             主进程、企业策略接入、用量上报
```

## 20. 当前推荐生产配置

企业服务：

```bash
LFCLAW_ENTERPRISE_HOST=0.0.0.0
LFCLAW_ENTERPRISE_PORT=8787
LFCLAW_ADMIN_TOKEN=请改成强密码
LFCLAW_ENTERPRISE_DATA=/opt/LfClaw/data/enterprise-data.json
```

客户端：

```bash
LFCLAW_ENTERPRISE_BASE_URL=http://服务器IP:8787
```

模型：

```text
模型 ID：glm-5.2
Base URL：https://open.bigmodel.cn/api/paas/v4
输入价格：8 / 100万 token
输出价格：28 / 100万 token
缓存读取：2 / 100万 token
积分倍率：10
```

员工：

```text
先按 1000 积分试运行
按需分配模型、MCP、技能
禁用后客户端应实时同步并停止使用
```
