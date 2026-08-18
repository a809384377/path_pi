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

### D3: 由 Pi 子进程继承 kernel ownership
- 日期: 2026-08-18
- 选项: MCP parent-only flock / lease+PID stale reclaim / daemon guardian / Pi继承lock fd
- 决策: 使用`fs-ext-extra-prebuilt@2.2.12`的kernel flock，logical与actual-native lock fd由MCP和Pi共同持有
- 理由: parent-only lock会在MCP SIGKILL后留下无锁orphan writer；继承fd能让旧Pi存活期间严格fail-closed，又不引入daemon
- 影响: orphan Pi可能长期阻塞接手，需人工终止；不允许时间/PID偷锁

### D4: 预分配 native ID，恢复不再调用 switch_session
- 日期: 2026-08-18
- 选项: 启动Pi后读取随机ID / gateway预生成ID；启动空Pi再switch / 直接`--session`恢复
- 决策: new用exclusive empty session-dir + `--session-id`，restore从JSONL header导出actual-native lock后用`--session`
- 理由: 所有会写Pi文件的动作必须发生在native ownership之后；record metadata不可作为alias fence的事实源
- 影响: Pi CLI seam与最低版本成为v2兼容要求

### D5: v1 迁移只向 canonical root 做 source-atomic consolidation
- 日期: 2026-08-18
- 选项: 每个旧root就地升级 / canonical root统一汇总；逐record partial activation / source-atomic
- 决策: 用户先移除caller-specific state-dir配置，再由canonical root迁移；candidate locks下fresh preflight，任一冲突整source不退休；dirty需显式attestation
- 理由: 两个旧root各自升级仍会形成两个lock namespace；partial activation会让冲突恢复不可解释
- 影响: README必须提供一次性升级顺序；durable intent支持retire后crash重试

### D6: 不扩建 task history registry
- 日期: 2026-08-18
- 选项: durable task index/tombstones / 仅保留record current+last
- 决策: `pi_wait`本地保持事件驱动，跨Server只识别record当前active/last task；更旧ID继续`unknown_task`
- 理由: 解决共享session不需要建立任务历史平台
- 影响: 后续task覆盖last result后，旧task不能由其他Server查询

### D7: 异常接手采用安全 reconciliation
- 日期: 2026-08-18
- 选项: `recoverable:false`永久报错 / 在完整ownership下验证并提升
- 决策: new session首次文件创建前持久化nonrecoverable；crash后新owner拿到logical+native locks再验证exclusive-dir/header，有效则发布host_interrupted+dormant+recoverable，无效则error
- 理由: 同时保留“先锁后写”和异常懒恢复，不把半创建record误当可恢复session
- 影响: 实现需覆盖prompt前、file创建后publication前等crash injection点

---

## 审查记录
- 初轮并行review发现4个Blocker、10个Major、3类Minor，完整轨迹见`ai/scratch/shared-session-registry-v2/spec-review.md`。
- 修订后最终reviewer `29a4d7e5`给出PASS：0 Blocker / 0 Major / 0 Minor。
- Darwin arm64 / Node 23.11.0 inherited-flock PoC通过：parent SIGKILL后child仍fence，child退出后自动释放。
- 用户于2026-08-18确认方案与fail-closed取舍，授权冻结Step 1并继续后续实现。

---

## 执行进度

### Step 2 完成: per-session store 与 v1 migration
- `SessionRecordStore`提供atomic no-replace create、expected revision update、动态list与drain；strict Pi header与secure-fs统一执行first-line identity、private mode和component symlink检查。
- `V1SessionMigrator`提供canonical-root discovery、dirty attestation、source-atomic unique quarantine、durable intent/receipt resume与immutable descendant acceptance。
- Step 3对接接口：`MigrationCandidateLockCoordinator.withCandidateLocks`、`orderedMigrationCandidates`（migration→source→logical→native）、`readPiSessionIdentity`；production coordinator需把candidate作为ordered set去重。
- 验收：typecheck、focused 39/39、全量74/74；独立review `cffea40d` PASS，完整报告与处置见`ai/scratch/shared-session-registry-v2/step2-review.md`。
- 剩余边界：真实flock、fd inheritance、runtime ownership与release ordering归Step 3；physical power-loss与恶意同UID进程不在验证范围。

---

## Step 3 完成: cross-MCP ownership
- `OwnershipLockManager`使用稳定永久lock files、nonblocking kernel flock、logical→native与migration→source→logical→native顺序；lock fd通过Pi额外stdio继承，parent SIGKILL时旧Pi继续fence。
- `PiRpcProcess`支持独占new `--session-dir/--session-id`与direct restore `--session`；SessionManager已接入v2 records、actual-native alias、crash reconciliation、admission barrier、terminal publication retry和confirmed release。
- 验收：focused 34/34、全量80/80、pack dry-run、diff-check、无测试残留进程；独立review `794f87ca` PASS，报告见`ai/scratch/shared-session-registry-v2/step3-review.md`。
- Step 4对接：server factory需注入`SessionRecordStore`/`OwnershipLockManager`并启动migration；status需动态list磁盘；remote current/last wait与README/config/tool error文案待完成。
- 剩余边界：声明矩阵的跨Node/平台clean-install与真实Pi 0.84.1集成尚未完成；orphan Pi fail-closed与恶意同UID/网络文件系统仍是spec边界。

## 踩坑记录

（Sprint 结束时提取。）
