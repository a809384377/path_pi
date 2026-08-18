# 计划

## 执行编排
- 实现: 单一 `worker` subagent 作为 active worktree 唯一代码 writer；主会话只维护 pflow 状态与验收
- 评审: 两个 fresh-context `reviewer`，分别攻击并发/生命周期正确性与测试/API 易用性
- 验收: 主会话读取关键契约、检查 diff，并亲自运行 build/typecheck/test 和 MCP smoke
- 运行形态: 交互式；子进程启动/终止和 integration test 由实现 worker 或主会话执行
- 危险操作归属: 不触碰生产数据；进程清理由实现 worker和主会话负责

## Step 1: 搭建 TypeScript/MCP 项目骨架 [done]
- 涉及: `package.json`、`tsconfig.json`、`src/index.ts`、测试配置
- 内容: 固定 Node/TypeScript/MCP SDK 基线、命令入口、构建和测试脚本
- 验证: 依赖安装成功，空骨架 build/typecheck 通过

## Step 2: 实现可测试的 Pi RPC transport 与持久化 store [done]
- 涉及: `src/rpc/`、`src/store/`、对应测试和 fake process
- 内容: 严格 LF JSONL、command correlation、readiness、process exit/error、原子 sessions.json、恢复元数据
- 验证: framing、协议错误、timeout、crash、原子读写测试通过

## Step 3: 实现 SessionManager 与 task/wait 状态机 [done]
- 涉及: `src/session/`、对应测试
- 内容: 并行 session、单 session 原子预留、agent_settled、终态 CAS、wait any/all/timeout、多 waiter、close/shutdown、懒恢复
- 验证: 设计 spec 的状态机与竞态测试全部通过

## Step 4: 接入五个 MCP tools 并补齐使用文档 [done]
- 涉及: MCP server/tool schemas、`README.md`、Claude Code/Codex 配置示例
- 内容: 参数校验、稳定返回结构、工具说明引导主 Agent 使用 spawn→wait→send
- 验证: fake Pi RPC 下完成 MCP 级 smoke，文档命令可复制执行

## Step 5: 独立对抗审查与修复 [wip]
- 涉及: 当前完整 diff、review artifacts、必要修复
- 内容: 并行审查正确性/竞态和测试/API；主会话核实后交回原 worker 修复 Blocker/Major
- 验证: 复审无未处理 Blocker/Major

## Step 6: 最终验收与 Sprint 收尾 [ ]
- 涉及: 全仓、Sprint 文档、ROADMAP/KNOWLEDGE
- 内容: 全量 build/typecheck/test、关键代码验收、成功标准回填、提交和归档
- 验证: Git 工作区干净，Sprint 成功标准全部可举证
