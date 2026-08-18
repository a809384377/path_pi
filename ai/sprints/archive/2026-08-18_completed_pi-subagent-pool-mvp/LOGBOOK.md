# 日志

## 状态: completed

---

## 决策记录

### D1: 以冻结 spec 为唯一实现依据
- 日期: 2026-08-18
- 选项: 实现时重新设计 / 严格按冻结 spec 收敛
- 决策: 按 `ai/specs/2026-08-18-pi-subagent-pool-design.md` 实现
- 理由: 用户已确认逻辑持久化边界，设计已完成独立攻击和范围收敛
- 影响: 遇到 daemon、worktree、push 等诉求一律视为超范围，不在本 Sprint 顺手加入

### D2: MVP 实现接口契约
- 日期: 2026-08-18
- 决策: `pi_spawn/pi_send` 返回 immutable `task_id`；`pi_wait` 按 task 观察不消费；每个 resident session 独占一个 Pi RPC 进程；clean restart 后按 `sessionFile` 懒恢复
- 理由: 与冻结 spec 和 Pi RPC `agent_settled` 生命周期一致
- 影响: Step 5 审查必须重点攻击同 session 原子预留、终态 CAS、wait 竞态、process tree shutdown 和 dirty restart 拒绝恢复

## 执行进度
- Step 1–4 实现位于 `src/`、`test/` 和 `README.md`；五工具注册入口为 `src/server.ts`。
- Pi transport 对接点是 `PiRpcProcess`；session/task 不变式集中在 `SessionManager`；持久化契约集中在 `JsonSessionStore`。
- 主会话验收命令 `npm run typecheck`、`npm test`、`npm pack --dry-run` 全部 exit 0；当前 18 tests pass。
- Step 5 第一轮独立审查原文：`ai/scratch/pi-subagent-pool-mvp/review-lifecycle.md`、`ai/scratch/pi-subagent-pool-mvp/review-api-test.md`。
- 处置: 修复全部 spec 内 Blocker/Major；补 prepack 与 LICENSE；Windows process-tree 不在 MVP 扩展实现，明确限定 macOS/Linux；修复后进行 focused re-review。
- Step 5 第二轮 focused review 原文：`ai/scratch/pi-subagent-pool-mvp/review2-termination.md`、`ai/scratch/pi-subagent-pool-mvp/review2-api.md`。
- 第二轮处置: shutdown 改为等待全部 cleanup 后聚合失败；close 保持 lifecycle ownership；POSIX 以 process group 消失而非 leader exit 作为清理完成；persistence failure 仍执行 process cleanup 且 wait 明确报错；补齐 finalizing 文档与 E2E 清理稳健性。
- Step 5 终审原文：`ai/scratch/pi-subagent-pool-mvp/review3-final.md`；结论 PASS，无 Blocker/Major。

---

## 踩坑记录

（本 Sprint 的具体时序问题已固化为状态机不变式和回归测试，无需提炼新的跨项目规则。）

---

## Sprint 总结

### 状态: completed
### 周期: 2026-08-18 -> 2026-08-18

### 目标与结果
| 成功标准 | 结果 |
|---------|------|
| 暴露五个 Pi MCP 工具 | pass — `pi_spawn`、`pi_send`、`pi_wait`、`pi_status`、`pi_close` |
| 三个 session 并行且结果不串线 | pass — fake Pi 并行集成测试覆盖 |
| session 完成后继续派活并恢复上下文 | pass — resident reuse 与 clean restart lazy restore 覆盖 |
| 生命周期与并发路径自动化测试 | pass — 35 tests 覆盖 wait、竞态、crash、close、shutdown、persistence 和 process group |
| Claude Code/Codex 配置文档 | pass — README 提供可复制配置与调用流程 |
| build/typecheck/test 和独立审查 | pass — typecheck/test/pack 通过，终审无 Blocker/Major |

### 后续注意事项
- v0.1.0 仅支持 macOS/Linux；Windows process-tree cleanup 不在本 Sprint 范围。
- 多个 session 写同一 cwd 时仍由主 Agent 负责拆分任务或提供不同 worktree。
- 宿主遭受 SIGKILL 或机器故障时不保证 task 继续执行，dirty session 会拒绝自动恢复。
