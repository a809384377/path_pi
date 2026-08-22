# Pi Agent MCP

[![npm](https://img.shields.io/npm/v/@pathli/pi-agent-mcp)](https://www.npmjs.com/package/@pathli/pi-agent-mcp)
[![CI](https://github.com/a809384377/path_pi/actions/workflows/ci.yml/badge.svg)](https://github.com/a809384377/path_pi/actions/workflows/ci.yml)

`Pi Agent MCP` 是一个本机 MCP Server，让 Claude Code、Codex 等 Agent 可以调用用户已经安装并认证的 Pi Coding Agent，并持续管理多个 Pi 会话。

## 它解决什么问题

直接使用 Pi 时，用户通常需要自己打开终端、输入任务、等待完成，再把结果复制回当前 Agent。当你希望“让一个 Agent 调用另一个 Agent”时，还会遇到：

- Claude/Codex 不知道如何启动和控制本机 Pi。
- 长任务缺少稳定的后台 `task_id`，容易阻塞主对话。
- 继续任务时容易新开会话，丢失 Pi 已有上下文。
- 多个 Host 可能同时操作同一个 Pi 会话，导致结果串线。
- Host 重启后，已有 Pi 会话难以查询和恢复。
- Pi 或 Host 异常退出后，任务状态难以准确协调。

本项目把这些能力封装为五个 MCP 工具：

| 工具 | 用途 |
| --- | --- |
| `pi_spawn` | 新建持久 Pi 会话并启动任务 |
| `pi_send` | 在已有会话中继续任务，保留上下文 |
| `pi_wait` | 等待后台任务完成 |
| `pi_status` | 查询会话与任务状态 |
| `pi_close` | 关闭逻辑会话和对应进程树 |

## 典型场景

- Claude Code 负责主流程，把代码审查、错误调查或测试编写交给 Pi。
- 主 Agent 继续处理其他工作，稍后等待 Pi 的最终结果。
- 使用 `pi_send` 在同一个 Pi 上下文中继续追问。
- Claude Code 与 Codex 共享本机会话状态，同时避免并发写坏同一会话。
- MCP Host 重启后继续查询和恢复已有任务。

## 工作原理

```text
用户
  ↓
Claude Code / Codex 等 MCP Host
  ↓ MCP
pi-agent-mcp
  ↓ 本机 JSON RPC
Pi Coding Agent：pi --mode rpc
  ↓
模型、文件系统、Shell 和 Pi 工具
```

`pi-agent-mcp` 不是新的 AI，也不替代 Pi。它是 MCP 与 Pi RPC 之间的协议适配器，同时负责进程启动、持久会话、后台任务、本地状态、恢复和跨进程并发控制。

完整的安装、配置、Skill 和安全说明见 [`npm/README.md`](npm/README.md)。

## 仓库分区

这个仓库明确分为两个区域：

```text
npm/           对外发布的 npm 包工程
development/   本地开发、测试与项目说明
```

### `npm/`：发布产品

`npm/` 可以独立构建和打包，包含：

- MCP Server 源码：`npm/src/`
- 可选 Agent Skill：`npm/skills/pi-agent/SKILL.md`
- npm 配置：`npm/package.json`
- MCP Registry 元数据：`npm/server.json`
- npm 页面使用的中文 README：`npm/README.md`
- 许可证：`npm/LICENSE`

发布包名：

```text
@pathli/pi-agent-mcp
```

### `development/`：开发环境与项目信息

`development/` 不进入 npm 发布包，包含：

- 单元、集成和端到端测试
- fake Pi 等测试夹具
- 本地开发与发布说明
- 项目架构和模块说明
- 开发专用 TypeScript 配置

入口：

- [`development/README.md`](development/README.md)
- [`development/ARCHITECTURE.md`](development/ARCHITECTURE.md)

## 开发命令

首次安装两个独立区域的依赖：

```sh
npm ci --prefix npm
npm ci --prefix development
```

类型检查和测试：

```sh
npm run typecheck --prefix npm
npm run typecheck --prefix development
npm test --prefix development
```

单独构建发布包：

```sh
npm run build --prefix npm
```

生成 npm tarball：

```sh
cd npm
npm pack
```

## 本地备份

本地迁移备份位于：

```text
.local-backups/
```

该目录被 Git 忽略，不会提交到 GitHub，也不会进入 npm 包。
