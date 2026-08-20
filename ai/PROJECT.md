# path_pi

## 是什么
公开的 Pi 配置、Agent Skills 与集成工具仓库，集中沉淀可复用的安装方案和插件实现。

当前核心组件是 `pi-agent-mcp`：一个本地 MCP Server，让 Claude Code、Codex 等 Agent 能并行派发任务给多个持久、可继续复用上下文的 Pi session；仓库同时提供配套 `pi-agent` Skill、脱敏配置样例和安装脚本。

## 工具与技术
- Node.js
- TypeScript
- Model Context Protocol SDK
- Pi RPC JSONL（`pi --mode rpc`）
- Agent Skills 标准
- Node.js test runner

## 部署方式
- 作为本地 stdio MCP Server，由 Claude Code 或 Codex 启动
- MCP Server 存活期间，每个 Pi session 对应一个独立 Pi RPC 子进程
- 宿主退出后依赖 Pi 原生 session 文件进行逻辑持久化和懒恢复
- Skill 通过安装脚本链接到宿主的用户级 skills 目录

## 项目结构
- `skills/` -- 可共享的 Agent Skills
- `src/` -- MCP Server、session 管理和 Pi RPC client
- `scripts/` -- 安装与维护脚本
- `examples/` -- 不含真实凭据的配置样例
- `docs/` -- 安装和使用文档
- `test/` -- 单元与集成测试
- `ai/` -- AI 协作产物（本文件、ROADMAP、KNOWLEDGE、sprints、scratch、cache）

## 当前版本
v0.1.0 -- pi-agent Skill + MCP 初始公开版本
