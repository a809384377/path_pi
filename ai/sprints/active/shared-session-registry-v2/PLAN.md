# 计划

## 执行编排
- 设计: 主会话综合 Codex/Pi 证据并冻结 v2 spec；fresh reviewer 攻击 ownership、stale lock 和迁移语义
- 实现: 一个 `worker` subagent 作为 active worktree 唯一代码 writer
- 评审: 两个 fresh-context `reviewer`，分别审查跨进程正确性与迁移/API/测试
- 验收: 主会话亲自运行两个 MCP Server 的多进程 E2E、typecheck、全量 test 和 pack
- 运行形态: 交互式；Step 1 为设计检查点，涉及进程所有权的实现与测试由单一 writer 执行
- 危险操作归属: 仅使用临时状态目录和 fake Pi；不触碰用户真实 `~/.pi` session 数据

## Step 1: 冻结共享 session registry v2 设计 [检查点] [done]
- 涉及: 新 v2 spec、Codex/Pi 持久化证据、ownership 与迁移契约
- 内容: 确定统一目录布局、session ID、per-session record 原子写、锁原语、owner 身份、正常释放、stale 判定、dirty session 行为、list/status 聚合和 v1 迁移
- 验证: 独立 reviewer 无未处理架构 Blocker；用户确认 spec 后冻结提交

## Step 2: 实现 per-session record store 与 v1 迁移 [done]
- 涉及: `src/store/`、store/migration tests
- 内容: 用独立 record 替换单一 manifest 写路径；实现并发安全的枚举、原子更新、schema/version 校验和幂等迁移
- 验证: 两个 store 实例并发写不同 session 不覆盖；迁移中断后可重试且结果一致

## Step 3: 实现跨 MCP Server 的 session ownership [done]
- 涉及: ownership/lock 模块、`SessionManager`、shutdown/recovery tests
- 内容: 每 session 单 owner；占用、续持、释放和 stale recovery；恢复前确认 ownership；状态查询不抢锁
- 验证: 两进程竞争同 session 只有一个成功；正常退出后可接手；异常 owner 不会造成自动双写

## Step 4: 接入统一默认目录并保持五工具 API [done]
- 涉及: `src/server.ts`、MCP schemas、README、配置示例
- 内容: Claude/Codex 共用默认目录，不再要求调用方拆分目录；保留 spawn/send/wait/status/close 契约并补充 `session_in_use` 说明
- 验证: 两个真实 stdio MCP Server 在同一临时 root 下并行使用不同 session；接手流程通过

## Step 5: 独立对抗审查与修复 [done]
- 涉及: 完整 diff、review artifacts、必要修复
- 内容: 攻击 TOCTOU、PID/锁复用、owner crash、迁移并发、record 损坏、close/restore 竞态和兼容回归
- 验证: fresh reviewers 无未处理 Blocker/Major

## Step 6: 最终验收与 Sprint 收尾 [wip]
- 涉及: 全仓、ROADMAP/KNOWLEDGE、Sprint 归档
- 内容: typecheck、全量 test、多进程 E2E、pack、关键不变式复核、版本与文档回写
- 验证: 成功标准全部举证，Git 干净，Sprint 归档
