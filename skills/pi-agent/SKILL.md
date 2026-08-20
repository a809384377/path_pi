---
name: pi-agent
description: 当用户明确调用 /pi-agent，或明确要求使用 Pi agent / pi-agent 作为 subagent 时，启动或继续 Pi 异步会话。仅询问能力、可用工具或 Skill 时只说明，不实际派发任务。
compatibility: Requires an MCP host configured with the local pi-agent server and its five pi_* tools.
allowed-tools: mcp__pi-agent__pi_spawn mcp__pi-agent__pi_send mcp__pi-agent__pi_wait mcp__pi-agent__pi_status mcp__pi-agent__pi_close
---

# Pi Agent

仅在用户明确调用本 Skill 时执行。

1. 新任务用 `pi_spawn`，传入任务和绝对 `cwd`；只有用户明确指定模型时才传 `model`。
2. 用返回的 `task_id` 只调用一次 `pi_wait`，不传超时参数。`pi_wait` 会保持同一个 MCP 请求，直到请求的任务进入终态。服务端 progress 心跳只防止客户端把静默等待判为 idle，不是工具结果。不要重复调用，也不要用 Bash、`pi_status`、产物文件或 session JSONL 轮询代替终态等待。取消 MCP 请求只停止本次等待观察，不会取消底层 Pi 任务。
3. 继续同一上下文时，对空闲 session 调用 `pi_send`，再等待新的 `task_id`；收到 `session_in_use` 时，不要并发写同一 session。
4. 已有 session 始终沿用创建时的模型，不得切换或通过新建 session 冒充续聊。
5. 任务结束后默认保留 session，便于继续；仅在用户要求终止或明确不再需要时调用 `pi_close`。

向用户回报结果时，简要说明 Pi 的结论以及 `session_id` 是否保留。
