# pi-agent-mcp

## 是什么
一个本地 MCP Server，让 Claude Code、Codex 等 Agent 能并行派发任务给多个持久、可继续复用上下文的 Pi session。

## 工具与技术
- Node.js
- TypeScript
- Model Context Protocol SDK
- Pi RPC JSONL（`pi --mode rpc`）
- Node.js test runner

## 部署方式
- 作为本地 stdio MCP Server，由 Claude Code 或 Codex 启动
- MCP Server 存活期间，每个 Pi session 对应一个独立 Pi RPC 子进程
- 宿主退出后依赖 Pi 原生 session 文件进行逻辑持久化和懒恢复

## 项目结构
- ai/ -- AI 协作产物（本文件、ROADMAP、KNOWLEDGE、sprints、scratch、cache）
- src/ -- MCP Server、session 管理和 Pi RPC client
- test/ -- 单元与集成测试

## 当前版本
v0.1.0 -- 初始版本
