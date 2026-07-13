# LfClaw 企业内部 AI 客户端

LfClaw 是基于 OpenClaw 生态与原桌面 Agent 客户端二次开发的企业内部 AI 客户端。当前版本的目标不是继续保留外部 SaaS 形态，而是把客户端、模型调用、用户目录和 OpenClaw 网关统一收敛到公司自有服务器，方便公司员工在 Windows 和 macOS 上安装使用。

## 当前定位

- 客户端名称：LfClaw
- 上游项目：原桌面 Agent 客户端
- Agent 引擎：OpenClaw
- 企业网关地址：`http://8.216.38.213:18791`
- 默认模型：`zai/glm-5.2`
- 用户进入方式：企业激活码
- 模型选择：隐藏，统一使用企业固定模型
- 外部登录：隐藏外部登录
- 外部更新：关闭，后续由公司内部发包

## 核心改造

### 1. 企业配置

企业配置位于：

```text
resources/enterprise-config/
```

主要文件：

```text
resources/enterprise-config/manifest.json
resources/enterprise-config/openclaw-gateway.json
```

这些配置会让客户端默认连接企业网关，并隐藏外部登录、模型选择和外部更新入口。

### 2. 多用户网关管理

服务端管理脚本：

```text
scripts/openclaw-gateway-manager.cjs
```

它负责：

- 提供统一公网入口 `18791`
- 按员工激活码识别用户
- 为每个员工创建独立 OpenClaw 运行目录
- 自动启动或复用对应员工的 OpenClaw 网关
- 将客户端 WebSocket 请求代理到对应用户的本地网关进程

服务端用户目录示例：

```text
/opt/lobsterai-gateway-manager/users/u_luyanpeng_f373_luyanpeng
```

### 3. 激活码网页管理

管理页面：

```text
http://8.216.38.213:18791/admin
```

当前为了降低内部使用门槛，不需要管理员口令。页面支持：

- 输入员工姓名生成激活码
- 自动生成员工英文全拼标识
- 自动生成 `userId` 和 `folderName`
- 禁用激活码
- 启用激活码
- 删除激活码
- 复制激活码
- 同名启用校验

示例：

```text
姓名：卢岩鹏
激活码：LFCLAW-LUYANPENG-CF2B57
userId：u_luyanpeng_f373
folderName：u_luyanpeng_f373_luyanpeng
```

如果姓名中有暂不支持自动转拼音的字，服务端会直接报错，不再生成 `uXXXX` 这类不可读目录。

> 注意：`18791` 当前没有管理员口令，正式公网使用前建议在阿里云安全组限制访问来源，例如只允许公司出口 IP 或办公网访问。

## 本地开发启动

安装依赖：

```bash
npm install
```

启动开发客户端：

```bash
npm run electron:dev
```

前端服务默认监听：

```text
http://localhost:5175
```

如果是第一次从上游完整构建 OpenClaw runtime，可使用：

```bash
npm run electron:dev:openclaw
```

## 常用验证命令

```bash
npm run build
npm run compile:electron
node --check scripts/openclaw-gateway-manager.cjs
```

## 企业发包与安装包保留策略

员工不需要拉代码或自行打包。维护人员打包后，将安装包整理到仓库的 `releases/` 目录，并只保留每个平台最近两个版本：

```text
releases/
  latest.json
  windows/
    <release-id>/
      LfClaw-<release-id>-windows-x64.exe
  mac/
    <release-id>/
      LfClaw-<release-id>-mac-arm64.dmg
```

Windows 发版流程：

```bash
npm run dist:win
npm run release:collect:win -- --release 2026.7.13
git add releases package.json scripts/package-release.cjs scripts/electron-builder-config.cjs README.md
git commit -m "chore: 发布 Windows 安装包"
git push
```

macOS 发版需要在 Mac 电脑上执行：

```bash
npm run dist:mac:arm64
npm run release:collect:mac -- --release 2026.7.13
git add releases
git commit -m "chore: 发布 macOS 安装包"
git push
```

`npm run release:collect` 会从 `release/` 目录复制安装包到 `releases/`，生成 `releases/latest.json`，并自动删除每个平台超过两个版本的旧目录。后续客户端自动更新也会基于这个 `latest.json` 做版本检查和下载安装。

## 服务端部署

服务器目录：

```bash
/opt/lobsterai-gateway-manager
```

上传管理脚本：

```bash
/opt/lobsterai-gateway-manager/openclaw-gateway-manager.cjs
```

systemd 服务文件示例位置：

```bash
/etc/systemd/system/lobsterai-gateway-manager.service
```

重启服务：

```bash
systemctl daemon-reload
systemctl restart lobsterai-gateway-manager
systemctl status lobsterai-gateway-manager
```

健康检查：

```bash
curl http://8.216.38.213:18791/health
```

正常返回示例：

```json
{"ok":true,"users":0,"leases":0,"port":18791}
```

## Windows 打包

```bash
npm run dist:win
```

产物默认输出到：

```text
release/
```

## macOS 打包

在 macOS 机器上执行：

```bash
npm install
npm run dist:mac:arm64
```

或 Intel：

```bash
npm run dist:mac:x64
```

macOS 图标会在 Mac 打包流程中通过 `iconutil` 生成 `.icns`。

## 图标资源

当前客户端图标已替换为 LfClaw 灰金双线条图标。主要资源：

```text
public/logo.png
build/icons/lfclaw-source.png
build/icons/win/icon.ico
build/icons/png/
resources/tray/
```

如果更换图标，需要同步更新上述资源并重新构建。

## Git 提交流程

当前企业二开仓库：

```text
https://git.code.tencent.com/tongkai/LfClaw.git
```

远程约定：

```text
origin   -> LfClaw 企业二开仓库
upstream -> 原始上游仓库
```

每次关键改动后执行：

```bash
git status
git add .
git commit -m "说明本次改动"
git push origin main
```

同时，关键节点需要同步到飞书知识库：

```text
https://bxz6lqekwy.feishu.cn/wiki/DHIgws6jkiizt1kOWsOcdr1jnSg
```

## 当前二开原则

- 不破坏已跑通的对话链路
- 企业配置优先，外部登录和模型选择逐步隐藏
- 服务端用激活码区分员工
- 每个员工独立 OpenClaw 目录，避免会话和配置串用
- 旧测试目录可以删除；正式目录必须使用可读 `folderName`
- 关键改动必须提交 Git，并同步飞书知识库

## 重要文件索引

```text
src/main/main.ts                                      Electron 主进程与企业激活逻辑
src/main/preload.ts                                   预加载 API 暴露
src/renderer/App.tsx                                  前端入口与企业激活流程
src/renderer/components/ModelSelector.tsx             固定模型与隐藏模型选择
src/main/libs/enterpriseConfigSync.ts                 企业配置读取与同步
src/main/libs/openclawEngineManager.ts                OpenClaw 引擎管理
src/main/libs/agentEngine/openclawRuntimeAdapter.ts   OpenClaw runtime 适配
scripts/openclaw-gateway-manager.cjs                  服务端多用户网关管理
resources/enterprise-config/                          企业默认配置
company-release/                                      企业发放材料与示例配置
```
