## Mac 用户自动打包说明

这部分给 Mac 用户或 Mac 构建机负责人使用。目标是在 Mac 电脑上通过 AI 干活工具自动完成 LobsterAI macOS 安装包构建。

### 适用对象

有 Mac 电脑，并且可以使用 AI 干活工具、Codex、Cursor、Claude Code 或其他能执行终端命令的工具的人。

### 打包目标

在 Mac 电脑上自动完成 LobsterAI macOS 安装包构建，并把产物放到项目目录的 company-release 文件夹中。

### 前置条件

Mac 电脑需要具备：

1. 已安装 Git
2. 已安装 Node.js 24.15 以上，且小于 25
3. 已安装 Xcode Command Line Tools
4. 已拉取 LobsterAI 项目代码

检查命令：

```bash
git --version
node -v
npm -v
xcode-select -p
```

如果 xcode-select -p 报错，执行：

```bash
xcode-select --install
```

### 推荐给 AI 干活工具的提示词

把下面这段直接发给 AI 干活工具：

```text
请在当前 LobsterAI 项目目录里帮我构建 macOS 安装包。

要求：
1. 先检查当前系统是否是 macOS。
2. 检查 Node.js 版本，必须 >=24.15 且 <25。
3. 检查 Xcode Command Line Tools 是否可用。
4. 不要改业务代码。
5. 执行 bash company-release/build-mac-on-macos.sh。
6. 如果脚本失败，读取错误日志并告诉我缺少什么环境。
7. 构建成功后，列出 company-release 目录里的 .dmg 或 .zip 文件。
8. 不要删除 Windows 安装包。
```

### 人工执行命令

如果不用 AI，也可以手动执行：

```bash
cd /path/to/LobsterAI
bash company-release/build-mac-on-macos.sh
```

脚本会依次执行：

```bash
npm run dist:mac:x64
npm run dist:mac:arm64
```

然后把 .dmg 或 .zip 复制到：

```text
company-release/
```

### 预期产物

成功后，company-release 目录下应该出现类似文件：

```text
LobsterAI-darwin-x64-2026.6.30-official.dmg
LobsterAI-darwin-arm64-2026.6.30-official.dmg
```

或者：

```text
LobsterAI-darwin-x64-2026.6.30-official.zip
LobsterAI-darwin-arm64-2026.6.30-official.zip
```

### 上传到飞书

Mac 包生成后，上传到飞书云盘或本文档所在知识库节点，并把链接补到本文档的安装包下载区。

### 常见失败处理

#### Node 版本不对

现象：

```text
Node x.x.x is too old
```

处理：

```bash
nvm install 24
nvm use 24
```

#### 缺少 Xcode Command Line Tools

现象：

```text
xcode-select: error
```

处理：

```bash
xcode-select --install
```

#### 原生依赖编译失败

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

#### 只想打 Apple Silicon 包

```bash
npm run dist:mac:arm64
```

#### 只想打 Intel 包

```bash
npm run dist:mac:x64
```
