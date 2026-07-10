# LobsterAI 公司内部客户端发放详细文档

版本：2026-07-03

适用范围：

- Windows 员工客户端发放
- macOS 员工客户端发放
- 公司统一远程 OpenClaw 网关接入
- 多用户登录后自动分配独立 OpenClaw 工作区

本文档的目标是让公司其他员工可以像普通软件一样安装和登录 LobsterAI，而不是每个人都手动启动脚本、配置网关、配置模型 key。

## 一、最终目标

公司其他用户安装 LobsterAI 后，只需要登录自己的 LobsterAI 账号，就能自动连接公司统一 OpenClaw 服务。

员工不需要：

- 手动启动脚本
- 手动填写 OpenClaw 网关地址
- 手动填写 OpenClaw 网关 token
- 手动配置模型 API Key
- 自己部署 OpenClaw 网关

最终体验：

```text
安装 LobsterAI -> 登录账号 -> 新建对话 -> 直接可用
```

## 二、当前架构

```text
员工电脑上的 LobsterAI 客户端
        |
        | 登录 LobsterAI 账号后自动请求
        v
http://8.216.38.213:18791
        |
        | 按 LobsterAI 登录用户分配独立 OpenClaw 实例
        v
127.0.0.1:19001 / 19002 / 19003 ...
```

公网只需要开放一个端口：

```text
18791/tcp
```

`19001-19999` 是服务器内部端口，不需要对公网开放。

原来的 `18790` 可以先保留为兜底测试入口，但公司员工客户端应统一走 `18791`。

## 三、角色分工

### 员工

员工只需要：

1. 安装客户端。
2. 登录自己的 LobsterAI 账号。
3. 开始对话。

员工不需要知道：

- OpenClaw 是什么
- 服务器 IP 是什么
- 网关 token 是什么
- 模型 API Key 是什么

### 管理员

管理员需要维护：

- 服务器 `lobsterai-gateway-manager` 服务
- 服务器上的 OpenClaw 模型配置
- 服务器上的模型 API Key
- 客户端安装包
- 客户端内置默认配置

### 客户端

客户端负责：

1. 读取内置默认配置。
2. 登录 LobsterAI 账号。
3. 使用登录 token 请求公司网关管理服务。
4. 拿到当前用户专属 `gatewayUrl` 和 `token`。
5. 自动连接远程 OpenClaw。

### 网关管理服务

`lobsterai-gateway-manager` 负责：

1. 校验 LobsterAI 登录 token。
2. 根据用户 ID 计算独立用户目录。
3. 为该用户启动独立 OpenClaw gateway。
4. 返回临时 lease 地址。
5. 转发 WebSocket 流量到用户自己的 OpenClaw gateway。
6. 空闲后自动回收用户进程。

## 四、新用户自动连接机制

新用户第一次打开客户端时，客户端会按下面顺序找配置：

1. 环境变量配置。
2. 用户本地配置。
3. 安装包内置企业默认配置。

对公司发放来说，我们依赖第 3 项：

```text
resources/enterprise-config/openclaw-gateway.json
```

因为新员工电脑上没有旧配置，所以客户端会自动使用内置配置：

```text
http://8.216.38.213:18791
```

然后客户端会自动请求：

```http
GET http://8.216.38.213:18791/api/openclaw/gateway-token
Authorization: Bearer <当前 LobsterAI 登录 token>
```

管理服务返回：

```json
{
  "code": 0,
  "data": {
    "gatewayUrl": "ws://8.216.38.213:18791/gateway/<leaseId>",
    "token": "<当前用户专属 gateway token>",
    "model": "zai/glm-5.2",
    "allowInsecurePrivateWs": true
  }
}
```

客户端拿到后自动连接，不需要用户做任何配置。

## 五、服务端部署检查清单

### 1. 检查 OpenClaw 命令路径

```bash
which openclaw
```

当前服务器返回的是：

```text
/usr/bin/openclaw
```

所以 systemd 配置里应使用：

```text
Environment=OPENCLAW_BIN=/usr/bin/openclaw
```

### 2. 检查默认模型

```bash
openclaw models status
```

预期至少能看到：

```text
Default: zai/glm-5.2
Configured models: zai/glm-5.2
```

如果还是 `zai/glm-5.1`，需要先在服务器上把默认模型切到 `zai/glm-5.2`。

### 3. 检查 OpenClaw 配置文件

```bash
ls -l /root/.openclaw/openclaw.json
```

这个文件会作为新用户配置模板。

### 4. 检查模型认证库

```bash
ls -l /root/.openclaw/agents/main/agent/openclaw-agent.sqlite
```

这个文件很关键。

如果它不存在，多用户网关能启动，客户端也能握手成功，但实际发消息时会缺少模型 key。

典型报错：

```text
No API key found for provider "zai"
```

### 5. 检查管理服务文件

```bash
ls -l /opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs
```

### 6. 检查 systemd 文件

```bash
vim /etc/systemd/system/lobsterai-gateway-manager.service
```

核心配置应类似：

```ini
[Unit]
Description=LobsterAI OpenClaw Gateway Manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/lobsterai-gateway-manager
Environment=LOBSTERAI_GATEWAY_MANAGER_PORT=18791
Environment=LOBSTERAI_GATEWAY_MANAGER_PUBLIC_BASE_URL=http://8.216.38.213:18791
Environment=OPENCLAW_BIN=/usr/bin/openclaw
Environment=LOBSTERAI_GATEWAY_MANAGER_DATA_ROOT=/opt/lobsterai-gateway-manager
Environment=LOBSTERAI_OPENCLAW_TEMPLATE_CONFIG=/root/.openclaw/openclaw.json
Environment=LOBSTERAI_OPENCLAW_TEMPLATE_AUTH_STORE=/root/.openclaw/agents/main/agent/openclaw-agent.sqlite
Environment=LOBSTERAI_OPENCLAW_MODEL=zai/glm-5.2
Environment=LOBSTERAI_OPENCLAW_PORT_START=19001
Environment=LOBSTERAI_OPENCLAW_PORT_END=19999
Environment=LOBSTERAI_OPENCLAW_IDLE_MS=1800000
ExecStart=/usr/bin/env node /opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

如果没有 `LOBSTERAI_OPENCLAW_TEMPLATE_AUTH_STORE` 这一行，也可以不加，因为脚本默认就是这个路径。

建议加上，方便以后排查。

### 7. 重启服务

```bash
systemctl daemon-reload
systemctl restart lobsterai-gateway-manager
systemctl status lobsterai-gateway-manager
```

### 8. 健康检查

```bash
curl http://8.216.38.213:18791/health
```

正常返回：

```json
{"ok":true,"users":0,"leases":0,"port":18791}
```

`users` 和 `leases` 是动态值，有人连接后会变大。

## 六、服务端更新管理服务脚本

当本地修改了：

```text
scripts/openclaw-gateway-manager.cjs
```

需要替换服务器文件：

```text
/opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs
```

推荐操作：

```bash
systemctl stop lobsterai-gateway-manager

cp /opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs \
  /opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs.bak.$(date +%Y%m%d%H%M%S)
```

上传新版脚本后：

```bash
node --check /opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs
systemctl start lobsterai-gateway-manager
systemctl status lobsterai-gateway-manager
```

如果是测试阶段，想让测试用户目录重新生成：

```bash
mv /opt/lobsterai-gateway-manager/users \
  /opt/lobsterai-gateway-manager/users.bak.$(date +%Y%m%d%H%M%S)
mkdir -p /opt/lobsterai-gateway-manager/users
systemctl restart lobsterai-gateway-manager
```

注意：正式上线后不要随便删除整个 `users` 目录，否则会清掉所有人的 OpenClaw 工作区状态。

## 七、客户端默认配置

客户端内置默认配置文件是：

```text
resources/enterprise-config/openclaw-gateway.json
```

当前应为：

```json
{
  "mode": "remote",
  "gatewayUrl": "http://8.216.38.213:18791",
  "model": "zai/glm-5.2",
  "allowInsecurePrivateWs": true
}
```

注意：这里不要再写死网关 token。

原因是 `18791` 管理服务会根据 LobsterAI 登录用户动态返回专属 `gatewayUrl` 和 `token`。

## 八、打包前检查

### 1. 确认内置配置不是旧端口

打开：

```text
resources/enterprise-config/openclaw-gateway.json
```

必须是：

```json
{
  "mode": "remote",
  "gatewayUrl": "http://8.216.38.213:18791",
  "model": "zai/glm-5.2",
  "allowInsecurePrivateWs": true
}
```

不能包含：

```text
18790
```

也不能包含固定 token。

### 2. 确认 electron-builder 会打包企业配置

检查：

```text
electron-builder.json
```

里面需要包含企业配置资源，让安装包带上默认配置。

### 3. 编译 Electron 主进程

```powershell
npm run compile:electron
```

如果本机正在运行开发版客户端，可能会遇到：

```text
EBUSY: resource busy or locked, open better_sqlite3.node
```

这种情况先关闭 LobsterAI 客户端和相关 Electron 进程，再重新执行。

### 4. 本地测试

启动开发版客户端后，看日志里是否出现：

```text
requesting personal gateway token
Using remote OpenClaw Gateway: http://8.216.38.213:18791/gateway/...
GatewayClient: onHelloOk
gateway client created and ready
```

如果看到这些，说明客户端自动接入链路正常。

## 九、新用户怎么使用

新用户流程：

1. 安装公司发放的 LobsterAI 客户端。
2. 打开客户端。
3. 登录自己的 LobsterAI 账号。
4. 直接新建对话测试：

```text
你是什么模型
```

如果正常，模型会回答类似：

```text
我是 zai/glm-5.2
```

新用户不需要进入设置页配置 OpenClaw。

## 十、已经安装过旧客户端的用户

如果员工以前装过测试版，电脑里可能已经存在旧的本地配置。

本地用户配置优先级高于安装包内置默认配置，所以旧配置可能会覆盖新的 `18791`。

Windows 用户检查：

```text
%APPDATA%\LobsterAI\openclaw-gateway.json
```

也就是：

```text
C:\Users\<用户名>\AppData\Roaming\LobsterAI\openclaw-gateway.json
```

macOS 用户检查：

```text
~/Library/Application Support/LobsterAI/openclaw-gateway.json
```

如果里面还是 `18790`，需要改成：

```json
{
  "mode": "remote",
  "gatewayUrl": "http://8.216.38.213:18791",
  "model": "zai/glm-5.2",
  "allowInsecurePrivateWs": true
}
```

或者直接删除这个文件，让客户端使用安装包内置默认配置。

## 十一、Windows 发放方式

在 Windows 构建机上生成安装包：

```powershell
npm run dist:win
```

生成后，把 `release` 目录里的安装包发给员工。

建议发放前先做一次干净机器测试：

1. 找一台没有装过 LobsterAI 的 Windows 电脑。
2. 安装新包。
3. 登录员工账号。
4. 新建对话问：`你是什么模型`。
5. 确认返回 `zai/glm-5.2`。

### Windows 旧配置清理脚本

如果某个员工以前装过旧版，可以让他执行：

```powershell
Remove-Item "$env:APPDATA\LobsterAI\openclaw-gateway.json" -Force -ErrorAction SilentlyContinue
```

然后重新打开 LobsterAI。

如果不想删除，而是强制写入新配置：

```powershell
$dir = "$env:APPDATA\LobsterAI"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
@'
{
  "mode": "remote",
  "gatewayUrl": "http://8.216.38.213:18791",
  "model": "zai/glm-5.2",
  "allowInsecurePrivateWs": true
}
'@ | Set-Content -Encoding UTF8 "$dir\openclaw-gateway.json"
```

## 十二、macOS 发放方式

macOS 安装包需要在 Mac 构建机上构建。

Intel Mac：

```bash
npm run dist:mac:x64
```

Apple Silicon Mac：

```bash
npm run dist:mac:arm64
```

通用包：

```bash
npm run dist:mac:universal
```

macOS 客户端使用同一份内置配置，也会自动连接：

```text
http://8.216.38.213:18791
```

### macOS 旧配置清理脚本

如果某个 Mac 用户以前装过旧版，可以执行：

```bash
rm -f "$HOME/Library/Application Support/LobsterAI/openclaw-gateway.json"
```

然后重新打开 LobsterAI。

如果需要强制写入新配置：

```bash
mkdir -p "$HOME/Library/Application Support/LobsterAI"
cat > "$HOME/Library/Application Support/LobsterAI/openclaw-gateway.json" <<'JSON'
{
  "mode": "remote",
  "gatewayUrl": "http://8.216.38.213:18791",
  "model": "zai/glm-5.2",
  "allowInsecurePrivateWs": true
}
JSON
```

## 十三、多用户隔离说明

每个 LobsterAI 登录用户在服务器上会生成自己的目录：

```text
/opt/lobsterai-gateway-manager/users/<userKey>/
```

目录结构：

```text
home/
state/
state/openclaw.json
state/agents/main/agent/openclaw-agent.sqlite
gateway.log
```

隔离内容包括：

- OpenClaw 运行状态
- Agent 数据
- 会话数据
- 工作区状态
- gateway token
- 日志文件

共享内容包括：

- 服务器上的 OpenClaw 程序
- 默认模型模板
- 模型 API Key 模板
- 统一入口 `18791`

也就是说，员工不需要各自部署网关，但每个人在服务端仍然有独立 OpenClaw 工作区。

## 十四、模型 key 管理策略

当前方案是“服务端统一 key”。

优点：

- 员工不用知道模型 API Key
- key 不下发到员工电脑
- 员工安装即用
- 管理员统一切模型

注意：

- 模型调用成本会集中在服务端配置的 key 上
- 如果要按员工统计用量，需要后续在管理服务里增加审计日志或计费统计
- 如果某个员工离职，应该禁用他的 LobsterAI 账号，而不是改客户端配置

## 十五、验收标准

每个员工验收时只看三件事：

1. 能登录 LobsterAI 账号。
2. 新建对话能正常回复。
3. 问 `你是什么模型` 时，返回 `zai/glm-5.2`。

服务端验收：

```bash
curl http://8.216.38.213:18791/health
```

多人登录后，`users` 应该大于等于 1。

开发日志验收：

```text
requesting personal gateway token
Using remote OpenClaw Gateway: http://8.216.38.213:18791/gateway/...
GatewayClient: onHelloOk
gateway client created and ready
```

## 十六、常见问题

### 1. OpenClaw gateway client stopped before handshake completed

说明客户端拿到了地址，但 WebSocket 握手中断。

优先检查：

```bash
systemctl status lobsterai-gateway-manager
journalctl -u lobsterai-gateway-manager -n 100
```

再检查：

```bash
curl http://8.216.38.213:18791/health
```

### 2. No API key found for provider "zai"

说明这个用户的隔离 OpenClaw 工作区没有模型 key。

检查服务器模板认证库：

```bash
ls -l /root/.openclaw/agents/main/agent/openclaw-agent.sqlite
```

确认管理服务脚本已经是新版，并且会复制模板认证库到用户目录。

如果测试用户目录已经在旧脚本下生成过，需要删除测试用户目录或整体重建测试 `users` 目录。

### 3. 客户端还在连 18790

说明用户电脑上存在旧本地配置。

删除或修改：

```text
%APPDATA%\LobsterAI\openclaw-gateway.json
```

macOS 删除或修改：

```text
~/Library/Application Support/LobsterAI/openclaw-gateway.json
```

### 4. 新模型不生效

先在服务器确认：

```bash
openclaw models status
```

再重启管理服务：

```bash
systemctl restart lobsterai-gateway-manager
```

如果用户目录已经生成过旧配置，需要删除对应测试用户目录后重新生成，正式用户不要随便删除。

### 5. `curl /health` 正常，但客户端不能对话

分两层看：

1. 客户端是否拿到 lease 并握手成功。
2. OpenClaw 实例内部是否能调用模型。

查看某个用户网关日志：

```bash
tail -n 100 /opt/lobsterai-gateway-manager/users/*/gateway.log
```

如果日志里是模型 key 报错，处理认证库。

如果日志里是进程退出，检查 `openclaw` 路径、端口、配置文件。

## 十七、推荐发放策略

第一阶段：小范围内测。

- 先发给 2-3 个同事。
- 确认 Windows 可以自动连接。
- 确认不同账号互不影响。
- 看服务器 `users` 是否增加。

第二阶段：整理安装包。

- Windows 单独发 `.exe` 安装包。
- Mac 单独发 `.dmg` 或 `.zip`。
- 附带一句使用说明：安装后登录账号即可，不需要配置。

第三阶段：正式推广。

- 服务器只暴露 `18791`。
- OpenClaw key 只放服务端。
- 员工客户端不保存模型 key。
- 后续切模型时只改服务端默认模型和模板配置。

## 十八、后续可增强项

### 1. 管理后台

后续可以做一个简单管理页面，查看：

- 当前在线用户
- 每个用户的内部端口
- 每个用户最后活跃时间
- 每个用户 token lease 数量
- 每个用户调用次数
- 每个用户报错日志

### 2. HTTPS/WSS

当前没有域名，所以先用：

```text
HTTP + WS
```

后续有域名后建议升级：

```text
HTTPS + WSS
```

这样浏览器安全策略和公网安全性都会更好。

### 3. 用户配额

后续可以在 `lobsterai-gateway-manager` 增加：

- 单用户并发限制
- 每日调用次数限制
- 每月 token 限制
- 黑名单/白名单
- 部门级配置

### 4. 模型按人分配

现在所有人默认：

```text
zai/glm-5.2
```

后续可以按用户返回不同模型：

```text
普通员工 -> zai/glm-5.1
研发/内测 -> zai/glm-5.2
管理员 -> 更多模型
```

这需要管理服务在 `/api/openclaw/gateway-token` 里根据用户身份返回不同 `model`。

## 十九、给员工的简短说明

可以直接复制下面这段发给员工：

```text
请安装新版 LobsterAI 客户端。

安装后直接登录自己的 LobsterAI 账号即可使用，不需要配置 OpenClaw、不需要启动脚本、不需要填写网关地址。

首次打开后，新建一个对话，输入：
你是什么模型

如果能正常回复，说明配置成功。

如果遇到无法连接，请截图发给管理员。
```

## 二十、给领导的简短说明

可以直接复制下面这段汇报：

```text
目前方案已经从“单人直连远程 OpenClaw 网关”升级为“公司统一网关管理服务”。

客户端只内置一个统一入口 http://8.216.38.213:18791。
员工登录 LobsterAI 后，客户端会自动向管理服务申请当前用户的专属 OpenClaw 网关，不需要员工手动配置。

服务端会按 LobsterAI 用户 ID 隔离 OpenClaw 运行目录，实现多用户共用一台服务器，但会话、Agent、状态、日志互相隔离。

Windows 和 Mac 客户端都可以使用同一套机制。后续发安装包即可，员工安装并登录后自动接入。
```

