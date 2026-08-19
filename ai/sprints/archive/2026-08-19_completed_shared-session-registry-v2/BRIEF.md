# Sprint: Shared Pi Session Registry v2

## 创建时间
2026-08-18

## 问题描述
当前 MCP Server 使用单一 `sessions.json` 作为全部 Pi session 的逻辑索引，因此同一状态目录只能有一个 writer。Claude Code 与 Codex 同时运行时必须配置不同的 `PI_AGENT_MCP_STATE_DIR`，导致两边无法共享 session，也把实现限制暴露给非技术用户。

本 Sprint 参考 Codex CLI 的“统一 HOME + 每 thread 独立持久化”形态，将状态存储改为统一目录下的 per-session records，并增加 per-session ownership，允许多个 MCP Server 同时创建和管理不同 Pi session，同时防止同一 session 被双重恢复或写入。

## 成功标准
- [ ] Claude Code、Codex 等调用方默认共用一个状态根目录，无需按调用方配置不同 `PI_AGENT_MCP_STATE_DIR`
- [ ] session 元数据按 session 独立持久化，不再由单一可覆盖的 `sessions.json` 承担运行时总账本
- [ ] 两个 MCP Server 进程可在同一状态根目录并行创建、运行和恢复不同 session，互不覆盖
- [ ] 同一个 session 同时最多被一个 MCP Server/ Pi RPC 进程拥有；其他调用方收到明确的 `session_in_use` 状态或错误
- [ ] 所有者正常退出后，另一调用方可接手并从 Pi 原生 session 文件恢复上下文
- [ ] 异常退出后的 stale ownership 有安全、可测试的回收规则，不会自动形成双写
- [ ] v0.1.0 `sessions.json` 有一次性、幂等且不丢 session 的迁移路径
- [ ] 现有五个 MCP 工具及并行、wait、懒恢复、进程组清理能力不退化
- [ ] 多进程集成测试、typecheck、全量测试和独立终审通过

## 范围
- 包含: v2 persistence spec、per-session record store、session ownership/lock、v1 manifest 迁移、多 MCP Server 进程集成测试、配置与 README 更新
- 不包含: 常驻 daemon、网络服务、跨机器共享、数据库服务、自动 worktree、同一 session 多 writer、正在执行 task 的跨进程迁移
