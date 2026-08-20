# Roadmap

## 高优先级
- [x] 发布公开 Pi 工具仓库（pi-agent Skill + MCP + 安装方案） → `ai/sprints/archive/2026-08-20_completed_publish-path-pi/`
- [x] 实现可被其他 Agent 调用、支持并行与上下文复用的 Pi MCP Server → `ai/sprints/archive/2026-08-18_completed_pi-subagent-pool-mvp/`
- [x] 改为统一状态目录、per-session records 和跨 MCP Server session ownership → `ai/sprints/archive/2026-08-19_completed_shared-session-registry-v2/`

## 待解决的问题
- [ ] 统一 close/send release 竞态下的次要错误语义：优先返回 `session_closed` 而非瞬时 `session_in_use`

## 想法/以后再说
- [ ] 评估宿主退出后仍保持 Pi OS 进程运行的独立 daemon 模式
- [ ] 评估自动 worktree 与同仓库并行写冲突防护
- [ ] 评估 ACP 或 MCP Tasks 兼容层
