# 日志

## 状态: active

---

## 决策记录

### D1: 不复制 Codex MCP 的重启限制
- 日期: 2026-08-18
- 选项: 完全仿 Codex，仅进程内 `threadId` 可继续 / 保留 Pi 的跨宿主懒恢复并改进持久化
- 决策: 保留跨宿主懒恢复，移除单一 `sessions.json` 的单 writer 限制
- 理由: 用户核心需求包括完成后继续派活和重启后恢复；Codex 当前 `codex-reply` 重启后可能 `Session not found`，不应把该限制一并复制
- 影响: v2 需要 per-session ownership，而不能只依赖当前进程的内存 Map

### D2: 设计先于实现
- 日期: 2026-08-18
- 选项: 直接重构 store / 先冻结跨进程 ownership 与迁移语义
- 决策: Step 1 产出并冻结新 spec，通过用户检查点后再写代码
- 理由: 锁失效、异常退出和旧数据迁移涉及不可含糊的不变式
- 影响: Step 1 不修改运行时代码

---

## 踩坑记录

（Sprint 结束时提取。）
