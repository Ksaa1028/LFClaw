## Mac 包企业网关验收要求

Mac 打包说明的核心不是单纯产出 .dmg 或 .zip，而是产出的 Mac 客户端必须默认连接公司统一 OpenClaw 网关。

### 必须内置的企业网关配置

Mac 打包前必须检查：

```bash
cat resources/enterprise-config/openclaw-gateway.json
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

注意：

```text
不能是 18790。
不能写死 gateway token。
```

当前项目里的 `company-release/build-mac-on-macos.sh` 已经内置这个校验。如果配置不对，脚本会直接失败，不会继续打包。

### 给 AI 干活工具的补充要求

如果让 Mac 用户通过 AI 干活工具打包，请在提示词里增加下面几条：

```text
打包前必须检查 resources/enterprise-config/openclaw-gateway.json。
要求 gatewayUrl 必须是 http://8.216.38.213:18791。
配置里不能包含 token 字段。
打包成功后，必须检查 .app 内部 Contents/Resources/enterprise-config/openclaw-gateway.json，确认仍然指向 http://8.216.38.213:18791。
如果这个验收不通过，不要交付安装包。
```

### 打包后检查命令

如果 release 下保留了 .app 目录，执行：

```bash
find release -path '*LobsterAI.app/Contents/Resources/enterprise-config/openclaw-gateway.json' -print -exec cat {} \;
```

里面必须包含：

```text
http://8.216.38.213:18791
```

如果只有 .dmg，先挂载 dmg，再检查 app 内部：

```bash
open release/*.dmg
cat /Volumes/LobsterAI*/LobsterAI.app/Contents/Resources/enterprise-config/openclaw-gateway.json
```

验收标准：

```text
1. gatewayUrl 是 http://8.216.38.213:18791
2. 不包含 token 字段
3. model 是 zai/glm-5.2
```

只有满足这个验收，Mac 用户安装后才会和 Windows 用户一样，登录 LobsterAI 账号后自动连接公司统一网关，不需要手动配置。
