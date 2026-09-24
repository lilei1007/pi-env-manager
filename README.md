# pi-env-manager

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)](#)

> pi-coding-agent 扩展：**按项目一键切换 JDK / Maven / Node 环境**，自动同步 VS Code 与 pi 的 shell 环境；工具缺失时经确认后自动安装。

- 🎯 **按项目切换**：对比项目 `pom.xml` 的 `<java.version>`，自动匹配本机 JDK（支持 `1.8` / `8` / `11` / `17` / `21`），无需手动改 PATH
- 🔄 **一处切换，处处生效**：写入 pi 环境、VS Code（Java 语言服务器 + Maven + 终端）、`.java-version`（jenv）、`.env`（launch.json）
- 🛠️ **缺失自动安装**：JDK / Maven / Node 缺失、或 JDK 版本不匹配 pom 要求时，经确认后自动安装（brew / apt / dnf / winget），装完自动重新检测
- 📦 **零依赖检测**：覆盖 jenv、SDKMAN、brew、n/nvm 及常见安装目录；jenv 为可选增强，无它也能用

## 目录

- [安装](#-安装)
- [快速开始](#-快速开始)
- [命令](#-命令)
- [切换环境会同步什么](#-切换环境会同步什么)
- [自动安装](#-自动安装)
- [工作原理](#-工作原理)
- [开发](#-开发)
- [常见问题](#-常见问题)
- [License](#-license)

## 📦 安装

### 前置要求

- [pi-coding-agent](https://github.com/earendil-works/pi)（建议最新版本）
- Node.js ≥ 18

### 方式一：GitHub（推荐）

```bash
pi install git:github.com/lilei1007/pi-env-manager
```

可指定分支或 tag：

```bash
pi install git:github.com/lilei1007/pi-env-manager@main
pi install git:github.com/lilei1007/pi-env-manager@v0.1.0
```

### 方式二：本地目录（开发调试）

```bash
pi install ./pi-env-manager
```

### 只试用一次，不写入配置

```bash
pi -e git:github.com/lilei1007/pi-env-manager
```

> ⚠️ 安装后请在 pi 中运行 **`/reload`** 使扩展生效。

## 🚀 快速开始

1. 在项目目录打开 pi
2. 运行 `/env set` — 自动检测本机 JDK/Maven/Node，对比 `pom.xml` 匹配或让你选择版本
3. 选择后自动写入配置；VS Code 执行 `Reload Window` 后即可使用
4. 查看当前配置：`/env status`

## 📖 命令

| 命令 | 说明 |
|---|---|
| `/env set` | 检测本机 JDK/Maven/Node 版本，对比项目 `pom.xml` 要求，自动匹配或让你选择，保存并切换环境 |
| `/env set --auto` | 自动模式：按 pom.xml 匹配，无匹配使用当前版本 |
| `/env install` | 自动安装缺失的 JDK/Node/Maven（经确认后执行） |
| `/env status` | 查看当前环境配置 |

## 🔧 切换环境会同步什么

| 文件 | 作用 |
|---|---|
| `.pi/env.json` | pi 侧环境配置 |
| `.vscode/settings.json` | VS Code：Java LS 的 `java.configuration.runtimes` / `java.jdt.ls.java.home`、Maven 的 `maven.executable.path` + `maven.terminal.useJavaHome`、终端 `JAVA_HOME` / `MAVEN_HOME` / `PATH` |
| `.java-version` | jenv 本地版本（终端进入目录自动切换 JDK） |
| `.env` | 供 `launch.json` envFile 使用 |

同时安装 spawnHook：此后 pi 里所有 shell 命令（`mvn` / `java` / `node`）自动使用选定版本。

## 🤖 自动安装

触发条件（**绝不主动安装**）：

- 某类工具（JDK / Maven / Node）完全检测不到
- 或 pom.xml 要求的 JDK 版本本机没有匹配

满足任一条件时 `/env set` 会弹出确认框，确认后按平台包管理器安装：

| 平台 | 包管理器 | JDK | Maven | Node |
|---|---|---|---|---|
| macOS | brew | `temurin@X`（按 pom 选 8/11/17/21） | `maven` | `node` |
| Linux | apt / dnf | `openjdk-X-jdk` | `maven` | `nodejs` |
| Windows | winget | `EclipseAdoptium.Temurin.X.JDK` | `Apache.Maven` | `OpenJS.NodeJS.LTS` |

安装顺序固定：**先 JDK → 再 Maven（依赖 JDK）→ 最后 Node**。装完自动重新检测并继续正常选择流程。**所有安装均需用户确认，不会静默执行**；失败时提示手动安装命令。

## 🧠 工作原理

```
检测（detectAll）
  ├─ JDK：jenv versions（可选）+ 目录扫描（/Library/Java/JavaVirtualMachines、brew opt、~/.jdk、sdkman 等）
  ├─ Node：n/nvm 版本目录、brew opt、PATH 兜底
  └─ Maven：目录扫描 + mvn -version 匹配
        ↓
匹配（parsePomJavaVersion + matchesJdk）
  ├─ pom.xml <java.version> → 语义化匹配本机 JDK
  └─ 缺失 / 不匹配 → ensureInstalled（确认 → 安装 → 重新检测）
        ↓
切换（proposeConfig → 交互选择 → 写配置）
  └─ .pi/env.json + .vscode/settings.json + .java-version + .env
```

## 💻 开发

```bash
git clone https://github.com/lilei1007/pi-env-manager
cd pi-env-manager

# 类型检查（需先安装类型依赖）
npm i -D typescript @types/node @earendil-works/pi-coding-agent
npx tsc --noEmit --strict --module esnext --moduleResolution bundler extensions/env-command.ts
```

本地调试：把 `extensions/env-command.ts` 拷到 `~/.pi/agent/extensions/` 后 `/reload`，或用 `pi -e ./pi-env-manager` 试用。

## ❓ 常见问题

**Q：VS Code 里用 Maven 编译，会自动用选定的 JDK 吗？**
会。`maven.executable.path` 指定 Maven 路径，`maven.terminal.useJavaHome: true` + `java.jdt.ls.java.home` 让 Java 语言服务器和 Maven 构建都使用选定 JDK。前提：已安装 Red Hat Java 与 Maven for Java 两个 VS Code 扩展；切换后执行 `Reload Window` 生效。

**Q：安装后没反应？**
运行 `/reload` 重新加载扩展。

**Q：与手工拷贝的扩展冲突？**
若 `~/.pi/agent/extensions/` 已有一份 `env-command.ts`，再安装本包会报 `Tool "bash" conflicts`——两者保留一个即可。

**Q：自动安装需要 root 权限吗？**
brew / winget 无需；Linux 的 apt/dnf 会尝试免密 sudo（`sudo -n`），失败时提示手动命令。

## 📄 License

[MIT](LICENSE)
