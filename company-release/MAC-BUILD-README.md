# LobsterAI Mac 用户自助打包说明

这个文件使用英文文件名，方便 macOS、Windows 和压缩工具正常显示。

本源码包用于公司内部 Mac 用户自行打包 LobsterAI 客户端。打出来的客户端已内置企业 OpenClaw 网关配置，默认连接：

```text
http://8.216.38.213:18791
```

## 操作步骤

1. 在 Mac 上安装环境：

```bash
xcode-select --install
brew install node@24 git
node -v
```

Node 要求 `v24.15.0` 或更高的 `24.x` 版本。

2. 解压源码包并进入目录：

```bash
unzip lobsterai-mac-build-source-2026.6.30.zip -d lobsterai
cd lobsterai
```

3. 安装依赖并打包：

```bash
npm install
bash company-release/build-mac-on-macos.sh
```

4. 到 `company-release/` 目录获取生成的 `.dmg` 或 `.zip` 安装包。

## 关键说明

- 打包脚本会校验 `resources/enterprise-config/openclaw-gateway.json`。
- `gatewayUrl` 必须是 `http://8.216.38.213:18791`。
- 配置里不能写死 token。
- Mac 用户不需要自己部署 OpenClaw 网关。
- 新用户安装客户端后，使用现有账号登录即可自动连接企业网关。

## 给 AI 工具的提示词

```text
请在 macOS 上打开这个 LobsterAI 源码目录，先执行 npm install，然后执行 bash company-release/build-mac-on-macos.sh。打包前必须确认 resources/enterprise-config/openclaw-gateway.json 的 gatewayUrl 是 http://8.216.38.213:18791，且没有写死 token。打包完成后，把 company-release 目录下生成的 dmg 或 zip 安装包交给我。
```

