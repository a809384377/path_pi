# path_pi 安装与认证

`path_pi` 是一个公开的 Pi 工具仓库，目前包含：

- `pi-agent-mcp`：让 Claude Code、Codex 等 MCP Host 调用多个可复用 Pi session。
- `skills/pi-agent`：约束 Host 正确调用 `pi_spawn`、`pi_wait`、`pi_send`、`pi_status`、`pi_close`。
- `examples/`：不含真实凭据的 Pi 配置样例。

> 安全说明：Skill 和 MCP Server 都能促使 Agent 执行本机操作。安装公开仓库前应先阅读源码。本仓库不会复制 `~/.pi/agent/auth.json`、真实 `models.json`、GitHub token 或 Pi session。

## 1. 前置条件

支持 macOS/Linux x64 或 arm64：

```sh
git --version
node --version       # 需要 >=22.19 且 <26
npm --version
pi --version         # 当前 MCP 针对 Pi 0.84.1 或兼容行为
```

安装 Pi：

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

## 2. Pi 模型认证

### 订阅账号

启动 `pi` 后运行：

```text
/login
```

可选择 Claude Pro/Max、ChatGPT Plus/Pro（Codex）、GitHub Copilot 等受支持提供商。

### API Key

优先使用 Pi 的 `/login` 保存认证，或确保环境变量始终存在于启动 Claude Code/Codex 的 **Host 进程环境** 中；MCP 子进程只能继承 Host 当时拥有的变量。不要把真实 key 提交到 Git，也不要把 key 明文写进 MCP 注册命令：

```sh
export ANTHROPIC_API_KEY='...'
export OPENAI_API_KEY='...'
pi
```

自定义 OpenAI-compatible provider 可从样例开始：

```sh
mkdir -p ~/.pi/agent
cp examples/models.example.json ~/.pi/agent/models.json
export EXAMPLE_API_KEY='...'
```

然后修改样例中的 `baseUrl`、模型 ID 和能力字段；`apiKey` 保持 `$EXAMPLE_API_KEY` 这样的环境变量引用，不要改成明文密钥。环境变量仅对继承它的进程生效。如果以后从另一个 shell、Dock 或 GUI 启动 Host，需要在那里重新提供变量；希望持久使用时优先通过 Pi `/login` 存入 `~/.pi/agent/auth.json`。

## 3. 获取仓库与 GitHub 认证

公开仓库无需 GitHub 登录即可克隆：

```sh
git clone https://github.com/a809384377/path_pi.git
cd path_pi
```

若要向自己的 fork 推送，再使用 GitHub CLI 认证：

```sh
gh auth login
# GitHub.com -> HTTPS -> Login with a web browser
gh auth status
```

GitHub 凭据只由 `gh`/系统 Keychain 管理，与 MCP 无关。

## 4. 推荐安装：MCP + Skill

自动构建并配置本机已安装的 Claude Code/Codex：

```sh
./scripts/install.sh
```

明确指定 Host：

```sh
./scripts/install.sh --host claude
./scripts/install.sh --host codex
./scripts/install.sh --host all
```

脚本默认：

1. 执行 `npm ci` 和 `npm run build`；
2. 将 Skill 链接到 Claude Code 的 `~/.claude/skills/pi-agent` 和/或 Codex 的 `~/.agents/skills/pi-agent`；
3. 为检测到的 Host 注册名为 `pi-agent` 的 stdio MCP Server；
4. 使用绝对 `node`、`pi` 和 MCP 入口路径，避免 GUI/子进程 PATH 不一致。

若已存在同名 Skill 链接或 MCP 注册，脚本会安全退出；它永远不会删除真实 Skill 文件或目录。确认需要替换已有**链接/注册**时：

```sh
./scripts/install.sh --host all --force
```

重启 Host 后，在 Claude Code 中调用 `/pi-agent`，在 Codex 中调用 `$pi-agent`；也可以直接要求 Host“使用 pi-agent 派发这个任务”。`--force` 会先移除同名 MCP 注册再重新添加；如果添加失败，需要再次运行安装脚本恢复。

### 为什么不是 `pi install`？

`pi-agent` Skill 是给 **Claude Code/Codex 这类 MCP Host** 使用的，而被调用的 Pi 是 MCP Server 管理的 worker。Pi 本身不内置 MCP Client，因此当前版本不推荐用 `pi install` 把这个 Host Skill 加载回 Pi；请使用仓库安装脚本。

未来新增真正的 Pi 原生 extension/skill 时，会在根 README 中单独给出 `pi install` 命令。

## 5. 手工配置 MCP

先构建：

```sh
npm ci
npm run build
PI_BIN="$(command -v pi)"
NODE_BIN="$(command -v node)"
REPO_ROOT="$(pwd -P)"
```

Claude Code：

```sh
claude mcp add --scope user --transport stdio \
  --env "PI_AGENT_MCP_PI_EXECUTABLE=$PI_BIN" \
  pi-agent -- "$NODE_BIN" "$REPO_ROOT/dist/src/index.js"
```

Codex：

```sh
codex mcp add \
  --env "PI_AGENT_MCP_PI_EXECUTABLE=$PI_BIN" \
  pi-agent -- "$NODE_BIN" "$REPO_ROOT/dist/src/index.js"
```

检查：

```sh
claude mcp get pi-agent
codex mcp get pi-agent
```

Claude Code 和 Codex 默认共享 `~/.pi/agent-mcp/` 逻辑注册表，但同一个 session 同时只能由一个活跃 Host 持有。

## 6. 手工安装 Skill

Claude Code：

```sh
mkdir -p ~/.claude/skills
ln -s "$(pwd -P)/skills/pi-agent" ~/.claude/skills/pi-agent
```

Codex：

```sh
mkdir -p ~/.agents/skills
ln -s "$(pwd -P)/skills/pi-agent" ~/.agents/skills/pi-agent
```

也可让脚本安装到自定义目录：

```sh
./scripts/install.sh --host none --skill-dir ~/.agents/skills
```

## 7. 更新

```sh
cd /path/to/path_pi
git pull --ff-only
./scripts/install.sh --host all --force
```

仓库内 Skill 使用符号链接安装，所以拉取后内容会同步更新；MCP TypeScript 仍需重新构建并重启 Host。

## 8. 卸载

移除 MCP 注册：

```sh
claude mcp remove pi-agent --scope user
codex mcp remove pi-agent
```

移除 Skill 链接：

```sh
rm ~/.claude/skills/pi-agent
rm ~/.agents/skills/pi-agent
```

`~/.pi/agent-mcp/` 内可能保留 session 元数据；确认不再需要历史 session 后再手工删除。不要在 MCP/Pi 进程仍运行时删除状态目录。

## 9. 常见问题

### Host 显示 MCP disconnected

```sh
node --version
pi --version
npm run build
ls -l dist/src/index.js
```

重新执行带 `--force` 的安装脚本，并重启 Host。

### `session_in_use`

另一个 Claude Code/Codex MCP Server或遗留 Pi RPC 子进程仍持有该 session。先关闭原 Host；不要删除 lock 文件来“解锁”。

### 并行任务会不会改坏同一仓库

MCP 只隔离 Pi session，不会自动创建 Git worktree，也不会阻止两个 session 同时改同一个文件。并行编码应分配互不重叠的任务，或给每个 session 使用独立 worktree。
