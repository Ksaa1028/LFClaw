# LobsterAI 公司内测安装包

生成时间：2026-07-03

## Windows

已完成。

本地文件：

```text
E:\own-workspace\LobsterAI\company-release\LobsterAI-Setup-x64-2026.6.30-official.exe
```

飞书下载链接：

```text
https://bxz6lqekwy.feishu.cn/file/YfTtbZbjio9Ds0xhB0ncupOTnRe
```

文件大小：约 245.55 MB

说明：Windows 用户下载安装后，登录 LobsterAI 账号即可自动连接远程 OpenClaw 网关。

## macOS

当前 Windows 构建机未产出 macOS 安装包。

已尝试执行：

```bash
npm run dist:mac:x64
```

失败位置：

```text
vendor/openclaw-runtime/mac-x64/node_modules/tree-sitter-bash
node-gyp rebuild
```

主要原因：

```text
当前 Windows 构建环境缺少完整 Windows SDK / C++ 构建链。
并且 macOS 安装包通常建议在 Mac 构建机上产出，尤其涉及原生依赖、签名、公证或 dmg 产物时。
```

建议在 Mac 构建机上执行：

```bash
npm run dist:mac:x64
npm run dist:mac:arm64
```

或生成通用包：

```bash
npm run dist:mac:universal
```

产出后上传到飞书云盘，并补充到知识库文档：

```text
https://bxz6lqekwy.feishu.cn/wiki/DHIgws6jkiizt1kOWsOcdr1jnSg
```

## 给 Mac 用户 / Mac 构建机负责人的自动打包说明

适用对象：

```text
有 Mac 电脑，并且可以使用 AI 干活工具、Codex、Cursor、Claude Code 或其他能执行终端命令的工具的人。
```

目标：

```text
在 Mac 电脑上自动完成 LobsterAI macOS 安装包构建，并把产物放到 company-release 目录。
打出来的 Mac 包必须默认连接公司统一 OpenClaw 网关：http://8.216.38.213:18791。
```

### 一、前置条件

Mac 电脑需要具备：

```text
1. 已安装 Git
2. 已安装 Node.js 24.15 以上，且小于 25
3. 已安装 Xcode Command Line Tools
4. 已拉取 LobsterAI 项目代码
```

检查命令：

```bash
git --version
node -v
npm -v
xcode-select -p
```

如果 `xcode-select -p` 报错，执行：

```bash
xcode-select --install
```

### 二、企业网关配置检查

Mac 包是否有意义，关键看它是否内置了公司统一网关配置。

打包前必须检查：

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

当前 `company-release/build-mac-on-macos.sh` 已经内置这个校验。如果配置不对，脚本会直接失败，不会继续打包。

### 三、推荐让 AI 干活工具执行的提示词

把下面这段直接发给 AI 干活工具：

```text
请在当前 LobsterAI 项目目录里帮我构建 macOS 安装包。

要求：
1. 先检查当前系统是否是 macOS。
2. 检查 Node.js 版本，必须 >=24.15 且 <25。
3. 检查 Xcode Command Line Tools 是否可用。
4. 检查 resources/enterprise-config/openclaw-gateway.json，必须指向 http://8.216.38.213:18791，且不能包含 token。
5. 不要改业务代码。
6. 执行 bash company-release/build-mac-on-macos.sh。
7. 如果脚本失败，读取错误日志并告诉我缺少什么环境。
8. 构建成功后，列出 company-release 目录里的 .dmg 或 .zip 文件。
9. 验证打出来的 .app 内部 Contents/Resources/enterprise-config/openclaw-gateway.json 仍然指向 http://8.216.38.213:18791。
10. 不要删除 Windows 安装包。
```

### 四、人工执行命令

如果不用 AI，Mac 用户也可以手动执行：

```bash
cd /path/to/LobsterAI
bash company-release/build-mac-on-macos.sh
```

脚本会依次执行：

```bash
npm run dist:mac:x64
npm run dist:mac:arm64
```

然后把 `.dmg` 或 `.zip` 复制到：

```text
company-release/
```

### 五、预期产物

成功后，`company-release` 目录下应该出现类似文件：

```text
LobsterAI-darwin-x64-2026.6.30-official.dmg
LobsterAI-darwin-arm64-2026.6.30-official.dmg
```

或者：

```text
LobsterAI-darwin-x64-2026.6.30-official.zip
LobsterAI-darwin-arm64-2026.6.30-official.zip
```

### 六、打包后验收

Mac 包打完后，必须验证安装包内置企业网关配置。

如果 `release` 下保留了 `.app` 目录，可以检查：

```bash
find release -path '*LobsterAI.app/Contents/Resources/enterprise-config/openclaw-gateway.json' -print -exec cat {} \;
```

里面必须包含：

```text
http://8.216.38.213:18791
```

如果只有 `.dmg`，先挂载 dmg，再检查 app 内部：

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

这样员工安装 Mac 包后，登录 LobsterAI 账号即可自动连接公司统一网关，不需要手动配置。

### 七、上传到飞书

Mac 包生成后，上传到飞书云盘或本文档所在知识库节点，并把链接补到知识库文档：

```text
https://bxz6lqekwy.feishu.cn/wiki/DHIgws6jkiizt1kOWsOcdr1jnSg
```

### 八、常见失败处理

#### 1. Node 版本不对

现象：

```text
Node x.x.x is too old
```

处理：

```bash
nvm install 24
nvm use 24
```

#### 2. 缺少 Xcode Command Line Tools

现象：

```text
xcode-select: error
```

处理：

```bash
xcode-select --install
```

#### 3. 原生依赖编译失败

先确认：

```bash
node -v
xcode-select -p
python3 --version
```

然后重新执行：

```bash
bash company-release/build-mac-on-macos.sh
```

#### 4. 只想打 Apple Silicon 包

```bash
npm run dist:mac:arm64
```

#### 5. 只想打 Intel 包

```bash
npm run dist:mac:x64
```
