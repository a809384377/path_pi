# Sprint: Pi Subagent Pool MVP

## 创建时间
2026-08-18

## 问题描述
Claude Code、Codex 等 MCP Client 目前无法把任务并行派给多个 Pi session，并在任务结束后继续复用这些 session 的上下文。本 Sprint 按冻结设计实现一个本地 stdio MCP Server，以最小工具面提供并行派发、等待结果、继续派活、状态查询、关闭和宿主重启后的逻辑恢复。

## 成功标准
- [ ] MCP Server 暴露 `pi_spawn`、`pi_send`、`pi_wait`、`pi_status`、`pi_close` 五个工具
- [ ] 至少三个 fake Pi RPC session 可并行运行，task 结果互不串线
- [ ] 同一 session 完成后可继续派活并复用 Pi session 文件
- [ ] wait any/all/timeout、多 waiter、并发 send、crash、close、shutdown 和恢复路径有自动化测试
- [ ] 提供 Claude Code 与 Codex 的本地 MCP 配置和使用示例
- [ ] build、typecheck、test 全部通过，独立审查无未处理 Blocker/Major

## 范围
- 包含: TypeScript 项目脚手架、窄 Pi RPC client、session/task 状态机、原子 session store、MCP tools、fake RPC 集成测试、配置文档
- 不包含: daemon、网络 API、UI、数据库、自动 worktree/文件锁、运行中 steer/follow-up、其他 Agent backend、真实模型调用作为默认测试
