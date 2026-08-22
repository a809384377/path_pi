# 架构说明

## 系统边界

本项目连接两个现有协议层：

```text
MCP Host（Claude Code / Codex）
  ↓ stdio MCP
Pi Agent MCP Server
  ↓ stdio JSON RPC
Pi Coding Agent
```

MCP Server 不包含模型、不实现 Pi 的推理能力，也不管理 Pi 认证。它调用用户本机的 `pi --mode rpc`。

## 发布模块

### `npm/src/index.ts`

可执行入口。无参数时启动 stdio MCP Server；传入命令行参数时拒绝运行，避免把 Server 入口误当成管理 CLI。

### `npm/src/server.ts`

MCP 适配层：

- 读取环境配置
- 初始化状态目录、记录存储和所有权锁
- 注册 `pi_spawn`、`pi_send`、`pi_wait`、`pi_status`、`pi_close`
- 将公开工具错误转换成稳定错误码
- 管理 stdio MCP 生命周期

### `npm/src/session/session-manager.ts`

核心会话调度层：

- 创建逻辑会话和不可变任务 ID
- 派发和继续任务
- 等待任务终态
- 管理 running、idle、dormant、closing 等状态
- 在安全条件满足时恢复 Pi 原生会话
- 协调关闭、异常退出和持久化

### `npm/src/rpc/`

Pi RPC 适配层：

- 用 `--mode rpc` 启动 Pi
- 通过 stdin/stdout 发送和接收逐行 JSON
- 关联请求 ID 与响应
- 处理 Pi 事件、超时、stderr 和进程退出
- 优雅停止或强制终止 Pi 进程树

### `npm/src/store/`

持久状态层：

- 原子创建和更新会话记录
- 验证文件权限、路径和符号链接
- 读取 Pi 原生 session header
- 迁移旧版状态目录
- 在崩溃或不确定写入后协调恢复

### `npm/src/ownership/`

跨进程所有权层：

- 用本机 `flock` 锁定逻辑会话和 Pi 原生会话
- 防止不同 MCP Host 同时控制同一个会话
- 把锁文件描述符继承给 Pi 子进程
- Host 异常退出时，Pi 仍可继续持有所有权

### `npm/skills/pi-agent/SKILL.md`

可选的 Agent 使用说明，不参与 Server 运行。它指导 Claude/Codex 正确组合五个工具。

## 本地数据

默认状态目录：

```text
~/.pi/agent-mcp
```

主要包含：

```text
sessions/     持久会话记录
pi-sessions/  Pi 原生会话文件
locks/        跨进程所有权锁
migrations/   状态迁移事务和回执
tmp/          原子写入临时文件
```

## 发布与开发分离

- `npm/` 是产品边界，拥有独立的 `package.json` 和 lockfile，可独立执行 `npm pack`。
- `development/` 是验证边界，拥有独立的开发依赖和 lockfile，不进入 tarball。
- 根目录不再是 npm 工程，只保留仓库导航、GitHub CI 和 Git 配置。
- 测试直接引用 `npm/src/`；涉及真实可执行入口的端到端测试验证 `npm/dist/`。

## 关键不变量

- 同一逻辑或原生 Pi 会话同一时间只能有一个拥有者。
- 任务 ID 一旦发布，不被后续任务复用。
- 终态必须持久保存后才能安全释放所有权。
- 状态观察不能偷偷取得会话所有权。
- 关闭和异常清理不能让旧异步结果复活已关闭会话。
- npm 包不能携带 Pi 凭据、模型配置或本地项目数据。
