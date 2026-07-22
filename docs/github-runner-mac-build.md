# GitHub Runner 打包 macOS 版本

本文说明如何用 GitHub Actions 的 macOS Runner 打包 LFClaw 的 macOS 安装包。

## 前提

1. 代码已经推送到 GitHub 仓库。
2. GitHub 仓库启用了 Actions。
3. 当前项目已经包含 workflow：

```text
.github/workflows/lfclaw-mac-release.yml
```

## 手动打包步骤

1. 打开 GitHub 仓库。
2. 点击顶部 `Actions`。
3. 左侧选择 `LFClaw macOS Release`。
4. 点击 `Run workflow`。
5. 选择打包架构：
   - `both`：同时打 Apple Silicon 和 Intel 两个包。
   - `arm64`：只打 Apple Silicon 包，适用于 M1/M2/M3/M4/M5。
   - `x64`：只打 Intel 包，适用于旧款 Intel Mac。
6. 点击绿色 `Run workflow`。
7. 等待构建完成。
8. 打开本次 workflow 运行记录，在 `Artifacts` 下载产物。

## 产物说明

通常会生成：

```text
LFClaw-2026072201-mac-arm64-official.dmg
LFClaw-2026072201-mac-x64-official.dmg
changelog-2026072201.zh.txt
```

实际版本号会根据当天日期和当日排序自动生成，例如：

```text
2026072201
2026072202
2026072203
```

## 上传服务器

下载后上传到服务器：

```text
/opt/LfClaw/releases/
```

企业服务会自动扫描该目录，并给客户端返回对应系统的最新安装包。

## 注意

- Windows 机器不能可靠打 macOS 包，所以必须使用 GitHub macOS Runner、真实 Mac、或 macOS 云机器。
- 当前内部使用阶段不做 Apple 签名和公证，因此 macOS 首次打开可能提示无法验证开发者。
- 如果只上传 Windows 包，macOS 客户端不会再识别到 Windows 更新包。

## 2026-07-22 打包排查记录

今天已把 GitHub Runner 打 macOS 包的主要阻断点修完：

1. 修正 workflow 条件表达式，`arm64`、`x64`、`both` 可以按选择生成对应构建任务。
2. 去掉依赖安装阶段对仓库 lock 文件的强依赖，避免空仓库或无 lock 文件时直接失败。
3. macOS 图标生成改为使用系统 `sips`，不再在 macOS Runner 上调用 Windows PowerShell 图像能力。
4. OpenClaw runtime 构建前自动启用 `corepack` 并准备 `pnpm`，避免 `Missing required command: pnpm`。
5. 给打包流程增加 Node 内存上限，降低 renderer 构建时内存不足导致失败的概率。
6. Electron Builder 打包时固定 `--publish never`，GitHub Actions 只上传 Artifacts，不自动创建 GitHub Release。

如果后续 GitHub Actions 失败，优先看失败日志里的第一条真实错误：

- `prepare icons failed`：优先检查 `public/logo.png` 和 `scripts/generate-tray-icons.js`。
- `Missing required command: pnpm`：优先检查 workflow 是否执行了 `corepack enable`。
- `bundle renderer failed` 或 Node 崩溃：优先检查是否带了 `NODE_OPTIONS=--max-old-space-size=4096`。
- `Cannot publish artifacts` 或 `GH_TOKEN`：确认打包命令带了 `--publish never`。
