# Pi Agent MCP

[![npm](https://img.shields.io/npm/v/@pathli/pi-agent-mcp)](https://www.npmjs.com/package/@pathli/pi-agent-mcp)
[![CI](https://github.com/a809384377/path_pi/actions/workflows/ci.yml/badge.svg)](https://github.com/a809384377/path_pi/actions/workflows/ci.yml)

`Pi Agent MCP` 是一个运行在本机的 stdio MCP Server。它让 Claude Code、Codex 等支持 MCP 的 Agent，可以把任务交给用户已经安装并认证的 [Pi Coding Agent](https://github.com/badlogic/pi-mono)，并持续管理多个 Pi 会话。

## 为什么需要它

直接使用 Pi 时，通常需要用户亲自打开终端、输入任务、等待结果，再把结果复制回当前 Agent。这个方式在偶尔使用时没有问题，但当你希望“让一个 Agent 调用另一个 Agent”时，会遇到一些实际困难：

- Claude/Codex 不知道如何启动和控制本机 Pi。
- 一个长任务会阻塞当前对话，缺少稳定的后台任务 ID。
- 继续同一任务时容易新开会话，丢失 Pi 已有上下文。
- 多个 Claude/Codex 进程可能同时操作同一个 Pi 会话，造成结果串线。
- MCP Host 重启后，之前的 Pi 会话难以继续使用。
- 不同 Host 之间缺少共享、可恢复的会话状态。
- Pi 进程异常退出或 Host 被关闭后，任务状态难以准确判断。

本项目把这些问题封装成五个 MCP 工具，让上层 Agent 可以像调用普通工具一样使用 Pi。

## 适用场景

### 1. 主 Agent 把独立任务交给 Pi

例如让 Claude Code 负责总体开发，同时把以下任务交给 Pi：

- 审查某个模块
- 调查一个错误
- 分析大型代码仓库
- 编写一组独立测试
- 比较不同实现方案

主 Agent 可以继续处理其他工作，再用 `pi_wait` 获取 Pi 的最终结果。

### 2. 保留 Pi 的上下文继续追问

第一次任务完成后，可以通过 `pi_send` 在同一个 Pi 会话中继续提问，而不是重新解释整个项目背景。

### 3. 多个 MCP Host 共享本机 Pi 会话

Claude Code 和 Codex 可以看到同一个本机会话注册表。系统会阻止两个 Host 同时写入同一个 Pi 会话，避免上下文被并发破坏。

### 4. 长任务与 Host 重启

任务和会话状态会保存在本机。MCP Host 重启后，可以查询已有会话，并在安全条件满足时继续使用。

## 工作原理

完整调用链如下：

```text
用户
  ↓
Claude Code / Codex 等 MCP Host
  ↓ MCP 工具调用
pi-agent-mcp（本项目）
  ↓ 本机 JSON RPC
Pi Coding Agent：pi --mode rpc
  ↓
模型、文件系统、Shell 和 Pi 工具
```

这里有两个协议层：

- **MCP**：连接 Claude/Codex 与 `pi-agent-mcp`。
- **Pi RPC**：连接 `pi-agent-mcp` 与本机 Pi 进程。

`pi-agent-mcp` 不是新的 AI 模型，也不替代 Pi。它的角色是：

- MCP 协议适配器
- Pi 进程启动器
- 持久会话管理器
- 后台任务调度器
- 跨进程并发控制器
- 本地状态与恢复协调器

## 五个 MCP 工具

| 工具 | 用途 |
| --- | --- |
| `pi_spawn` | 创建一个持久 Pi 会话并启动第一个任务 |
| `pi_send` | 在已有空闲会话中继续发送任务，保留上下文 |
| `pi_wait` | 等待一个或多个指定任务进入终态 |
| `pi_status` | 查看单个会话或列出所有未关闭会话 |
| `pi_close` | 永久关闭逻辑会话并停止对应进程树 |

`pi_spawn` 会快速返回 `session_id` 和 `task_id`。任务完成结果通过 `pi_wait` 获取。取消一次 `pi_wait` 只会停止等待，不会取消底层 Pi 任务。

## 安装要求

- Pi Coding Agent `>=0.84.1 <0.85.0`，并已完成模型认证
- Node.js `>=22.19 <26`
- macOS 或 Linux
- x64 或 arm64
- 本机文件系统；状态目录不支持网络文件系统

先确认 Pi 可以独立运行：

```sh
pi --version
pi
```

如果 Pi 没有可用的模型供应商，请先在 Pi 中执行 `/login`。

## 安装 MCP Server

```sh
npm install -g @pathli/pi-agent-mcp@0.1.1
command -v pi-agent-mcp
command -v pi
```

npm 安装只会安装 MCP Server 命令和包内静态文件。它不会：

- 安装 Pi
- 登录 Pi 或复制认证信息
- 修改 Claude/Codex 配置
- 自动注册 MCP Server
- 自动安装或覆盖 Skill
- 启动常驻后台服务

## 配置 Claude Code

将 `/absolute/path/to/pi` 替换为 `command -v pi` 的结果：

```sh
claude mcp add --scope user --transport stdio \
  --env PI_AGENT_MCP_PI_EXECUTABLE=/absolute/path/to/pi \
  pi-agent -- pi-agent-mcp
```

## 配置 Codex

```sh
codex mcp add \
  --env PI_AGENT_MCP_PI_EXECUTABLE=/absolute/path/to/pi \
  pi-agent -- pi-agent-mcp
```

Claude Code 与 Codex 对同名 MCP 配置的处理方式不同。执行前请先检查是否已经存在名为 `pi-agent` 的注册。

## 其他 MCP Host

`pi-agent-mcp` 不接受命令行参数；Host 应将它作为 stdio MCP Server 启动：

```json
{
  "mcpServers": {
    "pi-agent": {
      "command": "pi-agent-mcp",
      "args": [],
      "env": {
        "PI_AGENT_MCP_PI_EXECUTABLE": "/absolute/path/to/pi"
      }
    }
  }
}
```

也可以通过 `npx` 启动固定版本：

```json
{
  "command": "npx",
  "args": ["-y", "@pathli/pi-agent-mcp@0.1.1"]
}
```

该包使用预编译的本机文件锁依赖，建议优先全局安装。通过 `npx` 运行时，不要禁用 npm lifecycle scripts。

## 可选 Skill

npm 包内附带：

```text
skills/pi-agent/SKILL.md
```

Skill 不是 MCP Server 运行所必需的程序。它是一份给上层 Agent 阅读的使用说明，告诉 Agent：

- 新任务使用 `pi_spawn`
- 使用 `pi_wait` 等待同一个任务
- 继续上下文使用 `pi_send`
- 遇到 `session_in_use` 时不要并发写入
- 什么情况下保留或关闭会话

npm 不会自动安装 Skill。用户可以把这个文件单独交给 Agent 安装，也可以手工复制。

找到包内 Skill：

```sh
PACKAGE_ROOT="$(npm root -g)/@pathli/pi-agent-mcp"
```

首次安装到 Claude Code；已有文件会被保留：

```sh
TARGET="$HOME/.claude/skills/pi-agent/SKILL.md"
if [ -e "$TARGET" ]; then
  printf '已保留现有 Skill：%s\n' "$TARGET" >&2
else
  mkdir -p "$(dirname "$TARGET")"
  install -m 0644 "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" "$TARGET"
fi
```

首次安装到 Codex：

```sh
TARGET="$HOME/.agents/skills/pi-agent/SKILL.md"
if [ -e "$TARGET" ]; then
  printf '已保留现有 Skill：%s\n' "$TARGET" >&2
else
  mkdir -p "$(dirname "$TARGET")"
  install -m 0644 "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" "$TARGET"
fi
```

也可以直接从 GitHub 获取 `npm/skills/pi-agent/SKILL.md`，单独交给 Agent 安装。

## 更新

更新 MCP Server：

```sh
npm install -g @pathli/pi-agent-mcp@latest
```

npm 安装不会自动修改 Host 注册或 Skill 文件。

如果已安装 Skill，应先比较差异：

```sh
PACKAGE_ROOT="$(npm root -g)/@pathli/pi-agent-mcp"
diff -u \
  "$HOME/.claude/skills/pi-agent/SKILL.md" \
  "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" || true
```

确认后再显式替换，不要在未审查时覆盖本地修改。

## 卸载

根据实际配置移除 Host 注册：

```sh
claude mcp remove pi-agent --scope user
codex mcp remove pi-agent
```

再卸载 npm 包：

```sh
npm uninstall -g @pathli/pi-agent-mcp
```

npm 卸载不会删除 Skill、Pi 认证、本机 Pi 会话或 `~/.pi/agent-mcp` 状态目录。这些内容需要用户检查后手工处理。

## 本地状态与并发

默认共享状态目录：

```text
~/.pi/agent-mcp
```

MCP Server 使用本机文件锁保护逻辑会话和 Pi 原生会话：

- 不同 Host 可以并行运行不同会话。
- 同一个会话同一时间只能由一个 MCP Server 拥有。
- 文件锁会传递给 Pi 子进程，Host 异常退出时仍能防止另一个 Host 过早接管。
- 会话记录采用原子写入，减少崩溃时产生半写状态的风险。

## 配置项

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `PI_AGENT_MCP_PI_EXECUTABLE` | `pi` | Pi 可执行文件路径或命令 |
| `PI_AGENT_MCP_STATE_DIR` | `~/.pi/agent-mcp` | 高级用途的独立状态目录 |
| `PI_AGENT_MCP_LEGACY_STATE_DIRS` | 空 | 用系统路径分隔符连接的旧版状态目录 |
| `PI_AGENT_MCP_IMPORT_DIRTY` | 未设置 | 停止旧进程后，用 `1` 确认一次旧状态迁移 |
| `PI_AGENT_MCP_MAX_SESSIONS` | `16` | 单个 MCP Server 最多驻留的 Pi 进程数 |
| `PI_AGENT_MCP_COMMAND_TIMEOUT_MS` | `30000` | 单条 Pi RPC 命令响应超时 |
| `PI_AGENT_MCP_SHUTDOWN_GRACE_MS` | `1000` | 强制停止 Pi 前的优雅退出等待时间 |

## 安全边界

Pi 以当前操作系统用户权限运行。它能够读取和修改文件、执行命令、读取继承的环境变量，并消耗模型额度。它不是沙箱。

- 调用前应检查任务内容和工作目录。
- 不要安装来源不可信的 MCP Server 或 Skill。
- 不要把 API Key 写进 MCP 注册命令。
- 本包不会复制 `auth.json`、`models.json`、API Key 或 Pi 会话文件。
- 文件锁隔离的是其他操作系统用户，不隔离同一用户下所有可信 MCP Host。
- 多个不同 Pi 会话仍可能同时编辑同一仓库；并行开发时建议使用独立 Git worktree。
- 安全问题请通过 [GitHub Private Vulnerability Reporting](https://github.com/a809384377/path_pi/security/advisories/new) 私下报告，不要先公开未修复漏洞。

## 许可证

MIT
