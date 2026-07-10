# LobsterAI Mac 用户自助打包说明

本源码包用于公司内部 Mac 用户自行打包 LobsterAI 客户端。打出来的客户端已内置企业 OpenClaw 网关配置，默认连接：

```text
http://8.216.38.213:18791
```

## 1. 准备环境

在 Mac 终端执行：

```bash
xcode-select --install
brew install node@24 git
```

确认 Node 版本：

```bash
node -v
```

要求 `v24.15.0` 或更高的 `24.x` 版本。

## 2. 解压源码包

把 `lobsterai-mac-build-source-2026.6.30.zip` 解压到本地目录，例如：

```bash
cd ~/Downloads
unzip lobsterai-mac-build-source-2026.6.30.zip -d lobsterai
cd lobsterai
```

## 3. 安装依赖并打包

```bash
npm install
bash company-release/build-mac-on-macos.sh
```

脚本会自动检查企业网关配置，并分别构建 Intel Mac 与 Apple Silicon Mac 包。

## 4. 获取安装包

打包完成后，到下面目录取 `.dmg` 或 `.zip`：

```text
company-release/
```

## 5. 验证是否连接企业网关

安装并启动 LobsterAI 后，新用户正常登录现有账号即可。客户端会自动读取内置企业网关配置，不需要每个人单独部署 OpenClaw 网关，也不需要每个人手动填服务器地址。

发送一句：

```text
你是什么模型
```

如果能正常回答，并显示当前模型为企业网关配置的模型，说明打包和连接都成功。

## 6. 给 AI 工具的执行提示词

如果让 AI 编程工具代操作，可以直接给它这段话：

```text
请在 macOS 上打开这个 LobsterAI 源码目录，先执行 npm install，然后执行 bash company-release/build-mac-on-macos.sh。打包前必须确认 resources/enterprise-config/openclaw-gateway.json 的 gatewayUrl 是 http://8.216.38.213:18791，且没有写死 token。打包完成后，把 company-release 目录下生成的 dmg 或 zip 安装包交给我。
```

