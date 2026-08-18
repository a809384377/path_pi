# 日志

## 状态: active

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

---

## 踩坑记录

（sprint 结束时提取，无踩坑则留空）
