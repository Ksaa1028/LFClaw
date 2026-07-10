# OpenClaw 多用户网关管理服务部署说明

这份文档用于把当前“单用户远程 OpenClaw 网关”升级成“多用户统一入口”。

目标效果：

```text
客户端只连接：
http://8.216.38.213:18791

服务端内部按用户自动分配：
127.0.0.1:19001
127.0.0.1:19002
127.0.0.1:19003
...
```

公网只需要开放 `18791`。  
当前已经跑通的 `18790` 不动，继续作为兜底测试网关。

## 1. 服务说明

管理服务文件：

```text
scripts/openclaw-gateway-manager.cjs
```

它提供三个接口：

```text
GET /health
GET /api/openclaw/gateway-token
WS  /gateway/:leaseId
```

客户端会先请求：

```http
GET http://8.216.38.213:18791/api/openclaw/gateway-token
Authorization: Bearer <LobsterAI 登录 token>
```

管理服务会：

1. 用现有 LobsterAI 登录 token 校验用户身份。
2. 根据用户 ID 创建独立 OpenClaw 运行目录。
3. 如果该用户的 OpenClaw 网关没启动，就自动启动。
4. 返回该用户专属的 `gatewayUrl` 和 `token`。

返回示例：

```json
{
  "code": 0,
  "data": {
    "gatewayUrl": "ws://8.216.38.213:18791/gateway/lease_xxx",
    "token": "user_gateway_token",
    "model": "zai/glm-5.2",
    "allowInsecurePrivateWs": true,
    "expiresAt": "2026-07-03T08:00:00.000Z"
  }
}
```

客户端拿到这个结果后，会连接：

```text
ws://8.216.38.213:18791/gateway/lease_xxx
```

管理服务再把这个 WebSocket 转发到该用户内部的 OpenClaw：

```text
127.0.0.1:19001
```

## 2. 服务器准备

先确认服务器上已经能直接运行 OpenClaw：

```bash
openclaw --version
openclaw models status
```

确认已有可用配置：

```bash
ls -l /root/.openclaw/openclaw.json
```

如果没有，先按你之前的方式把 OpenClaw 模型配置好，例如 `zai/glm-5.2`。

## 3. 上传文件

在服务器上创建目录：

```bash
mkdir -p /opt/lobsterai-gateway-manager
```

把本地文件上传到服务器：

```text
scripts/openclaw-gateway-manager.cjs
deploy/systemd/lobsterai-gateway-manager.service
```

放置位置：

```bash
/opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs
/etc/systemd/system/lobsterai-gateway-manager.service
```

如果你在服务器上用 `scp`，示例：

```bash
scp scripts/openclaw-gateway-manager.cjs root@8.216.38.213:/opt/lobsterai-gateway-manager/
scp deploy/systemd/lobsterai-gateway-manager.service root@8.216.38.213:/etc/systemd/system/
```

## 4. 检查 systemd 配置

服务文件默认配置如下：

```text
监听端口：18791
公网地址：http://8.216.38.213:18791
OpenClaw 命令：/usr/local/bin/openclaw
数据目录：/opt/lobsterai-gateway-manager
模板配置：/root/.openclaw/openclaw.json
默认模型：zai/glm-5.2
内部端口范围：19001-19999
空闲回收时间：30 分钟
```

如果你的 `openclaw` 不在 `/usr/local/bin/openclaw`，先查实际路径：

```bash
which openclaw
```

然后修改：

```bash
nano /etc/systemd/system/lobsterai-gateway-manager.service
```

把这一行改成实际路径：

```text
Environment=OPENCLAW_BIN=/usr/local/bin/openclaw
```

## 5. 启动服务

执行：

```bash
systemctl daemon-reload
systemctl enable --now lobsterai-gateway-manager
systemctl status lobsterai-gateway-manager
```

查看日志：

```bash
journalctl -u lobsterai-gateway-manager -f
```

## 6. 开放端口

只需要开放公网端口 `18791/tcp`。

如果服务器使用 `ufw`：

```bash
ufw allow 18791/tcp
```

如果是阿里云服务器，需要在安全组里放行：

```text
协议：TCP
端口：18791
来源：你的办公网络 IP 或 0.0.0.0/0
```

注意：内部端口 `19001-19999` 不需要对公网开放。

## 7. 测试健康检查

在本地 Windows 或服务器上执行：

```bash
curl http://8.216.38.213:18791/health
```

正常返回类似：

```json
{
  "ok": true,
  "users": 0,
  "leases": 0,
  "port": 18791
}
```

## 8. 客户端配置

后续客户端企业默认配置应改成：

```json
{
  "mode": "remote",
  "gatewayUrl": "http://8.216.38.213:18791",
  "model": "zai/glm-5.2",
  "allowInsecurePrivateWs": true
}
```

不再直接配置 `18790`。

当前 `18790` 继续保留为兜底：

```text
http://8.216.38.213:18790
```

## 9. 数据隔离方式

每个用户会有独立目录：

```text
/opt/lobsterai-gateway-manager/users/<userKey>/
```

每个用户目录下面包含：

```text
home/
state/
state/openclaw.json
gateway.log
```

这意味着：

- 会话隔离
- Agent 配置隔离
- 工作区隔离
- 技能状态隔离
- Gateway token 隔离
- 日志隔离

## 10. 空闲回收

默认空闲 30 分钟后，管理服务会停止该用户的 OpenClaw 进程。

配置项：

```text
LOBSTERAI_OPENCLAW_IDLE_MS=1800000
```

如果想改成 10 分钟：

```text
LOBSTERAI_OPENCLAW_IDLE_MS=600000
```

修改后重启：

```bash
systemctl restart lobsterai-gateway-manager
```

## 11. 常用排查命令

查看管理服务状态：

```bash
systemctl status lobsterai-gateway-manager
```

实时日志：

```bash
journalctl -u lobsterai-gateway-manager -f
```

查看用户运行目录：

```bash
ls -lah /opt/lobsterai-gateway-manager/users
```

查看内部端口：

```bash
ss -lntup | grep 190
```

查看某个用户网关日志：

```bash
tail -f /opt/lobsterai-gateway-manager/users/<userKey>/gateway.log
```

## 12. 当前限制

当前没有域名，所以第一版是：

```text
HTTP + WS
```

这适合内测，不适合长期公网正式使用。

后续有域名后建议升级成：

```text
HTTPS + WSS
```

届时只需要把公网入口换成：

```text
https://你的域名
wss://你的域名
```

客户端和管理服务的整体架构不用推倒重来。
## 11. 激活码管理接口

为了避免每次新增员工都登录服务器手改 JSON，管理服务提供了一个轻量管理员接口。

先在 systemd 服务中配置管理员口令：

```ini
Environment=LOBSTERAI_GATEWAY_MANAGER_ADMIN_TOKEN=请换成一串足够长的随机字符串
```

重启服务：

```bash
systemctl daemon-reload
systemctl restart lobsterai-gateway-manager
```

创建或更新员工激活码：

```bash
curl -X POST http://8.216.38.213:18791/api/admin/activation-codes \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: 管理员口令" \
  -d '{
    "userId": "u_10001",
    "displayName": "张三",
    "folderName": "u_10001_zhangsan"
  }'
```

如果不传 `activationCode`，服务端会自动生成类似 `LFCLAW-XXXXXX-XXXXXX-XXXXXX` 的激活码。

查看当前激活码：

```bash
curl http://8.216.38.213:18791/api/admin/activation-codes \
  -H "X-Admin-Token: 管理员口令"
```

禁用激活码：

```bash
curl -X POST http://8.216.38.213:18791/api/admin/activation-codes/disable \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: 管理员口令" \
  -d '{"activationCode":"LFCLAW-XXXXXX-XXXXXX-XXXXXX"}'
```

禁用时会同时禁用该激活码已签发过的企业 token。员工本地客户端再次请求网关时会失效。

## 12. 测试用户目录处理

旧测试用户目录通常在：

```bash
/opt/lobsterai-gateway-manager/users/
```

正式启用激活码后，用户目录会优先使用激活码里配置的 `folderName`，例如：

```text
/opt/lobsterai-gateway-manager/users/u_10001_zhangsan
```

因此旧测试目录不会自动混到正式员工目录里。

如果测试目录里没有要保留的会话或配置，推荐先备份再清理：

```bash
systemctl stop lobsterai-gateway-manager
mkdir -p /opt/lobsterai-gateway-manager/users_backup_$(date +%Y%m%d)
mv /opt/lobsterai-gateway-manager/users/* /opt/lobsterai-gateway-manager/users_backup_$(date +%Y%m%d)/ 2>/dev/null || true
mkdir -p /opt/lobsterai-gateway-manager/users
systemctl start lobsterai-gateway-manager
```

如果其中某个测试目录就是你自己后续要继续用的目录，不要删；可以把对应激活码的 `folderName` 设置成这个目录名继续沿用。

