## Review
### Blocker
1. **Pi 的模型/API 失败会被误报为任务成功**
   - **用户现象**：鉴权失败、provider 超时、无效请求等真实 Pi 运行错误最终仍由 `pi_wait` 返回 `status: "completed"`，通常只有空 `response`；主 Agent 会把失败任务当成已完成。
   - **复现**：使用会在 prompt 后产生 `AssistantMessage.stopReason = "error"` 的 provider 配置调用 `pi_spawn`，随后 `pi_wait`。Pi 仍会发送 `agent_settled`，实现仅调用 `get_last_assistant_text` 并无条件完成任务。当前 fake 始终生成成功文本，因此测试无法暴露该问题，见 `test/fixtures/fake-pi.mjs:80`。
   - **位置**：`src/session/session-manager.ts:337`、`src/session/session-manager.ts:343`。
   - **最小修复**：在 RPC 层读取最后 assistant message 的 `stopReason/errorMessage`，或监听并保存 `message_end`/`agent_end` 的终态；只有非 `error`/`aborted` 的结果才能标记 `completed`，并为 provider error 添加 fake/真实协议回归测试。
### Major
1. **MCP stdin EOF 不会触发 shutdown**
   - **用户现象**：Claude Code/Codex 仅关闭 stdio 写端而未及时发送信号时，MCP server 和 Pi 子进程继续存活，manifest 保持 dirty；下次启动会把原 session 判为不可恢复的 `error`。
   - **复现**：启动 stdio server、调用 `pi_spawn`，随后只关闭客户端 stdin。`runStdioServer` 仅监听 `SIGINT`、`SIGTERM` 和 transport `onclose`，没有监听 stdin `end`/`close`；SDK 的 stdio transport 本身也不在 EOF 时调用 `close()`。
   - **位置**：`src/server.ts:109`、`src/server.ts:121`、`src/server.ts:123`。
   - **最小修复**：显式监听 `process.stdin` 的 `end`/`close` 并 await 同一个幂等 shutdown；增加真正启动 `dist/src/index.js`、关闭其 stdin、验证进程树和 manifest 的端到端测试。
2. **shutdown/close 可在默认配置下卡住 30 秒**
   - **用户现象**：Pi 卡死或不响应 `abort` 时，宿主关闭会先等待 RPC command timeout，默认 30 秒，而不是 README 所述的 1 秒 grace；MCP 客户端很可能先强杀 server，使 session 变 dirty。
   - **复现**：让 fake Pi 接受 prompt 但忽略 `abort` response，再调用 `pi_close`、发送 `SIGTERM` 或触发 shutdown。代码在调用 `stop()` 前顺序等待 `rpc.abort()`。
   - **位置**：`src/session/session-manager.ts:251`、`src/session/session-manager.ts:273`；默认超时配置位于 `src/server.ts:17`。
   - **最小修复**：将 abort 纳入 shutdown grace 的并发 race，或发送 abort 后立即进入 `stop()`，由 `stop()` 的 grace/force-kill 负责最终边界；测试必须断言总关闭时长有界。
3. **协议错误会过早丢弃 child handle，可能留下孤儿 Pi**
   - **用户现象**：Pi 输出畸形 JSON、未知 response ID 等协议错误时，server 会认为进程已退出并允许后续恢复，但旧 Pi 若忽略 `SIGTERM` 仍可能运行，造成两个进程同时写同一 Pi session。
   - **复现**：让子进程输出畸形 frame 并忽略 `SIGTERM`。`#protocolFailure` 发送信号后立即调用 `#handleTermination`，后者清空 `#child`；之后 `stop()` 看不到 child，无法在 grace 后 `SIGKILL`。
   - **位置**：`src/rpc/pi-rpc-process.ts:238`、`src/rpc/pi-rpc-process.ts:244`、`src/rpc/pi-rpc-process.ts:141`。
   - **最小修复**：区分“协议已失败”和“OS 进程已确认退出”；在真实 `exit/error` 前保留 child handle，并执行完整 TERM→grace→KILL 流程，最后才发出一次 exit 事件。
4. **child stdin 的 EPIPE 可导致整个 MCP server 未捕获异常退出**
   - **用户现象**：Pi 在 RPC 写入竞态中关闭 stdin 时，单个 session 的 EPIPE 可能变成 Writable stream 的未处理 `error` 事件，带崩整个 MCP server，而不只是将对应 task 标记失败。
   - **复现**：让子进程在 `#send` 的 running 检查后、`stdin.write` 前退出或关闭 stdin。实现只处理 write callback，没有为 `child.stdin` 注册 `error` listener；现有 `PassThrough` fake 不会模拟 EPIPE。
   - **位置**：`src/rpc/pi-rpc-process.ts:104`、`src/rpc/pi-rpc-process.ts:182`；测试盲区位于 `test/pi-rpc-process.test.ts:72`。
   - **最小修复**：注册 stdin `error` handler，走幂等的 transport failure/真实退出清理路径，并增加 EPIPE 与 exit 同时发生的测试。
5. **fresh checkout 发布的 npm 包可能没有声明的 bin**
   - **用户现象**：从干净 commit 直接执行 `npm publish`/`npm pack` 时，包内可能没有 `dist/src/index.js`；安装成功后 `pi-agent-mcp` bin 指向不存在的文件。当前验收先 build/test 再 pack，会掩盖该问题。
   - **复现**：在 fresh checkout 中执行 `npm ci && npm pack --dry-run` 并检查 tarball。`dist/` 被忽略，`files` 和 `bin` 都依赖它，但没有 `prepack`/`prepare` build lifecycle。
   - **位置**：`package.json:6`、`package.json:10`、`package.json:14`、`.gitignore:2`。
   - **最小修复**：增加 `prepack: "npm run build"`，并在干净 checkout 中验证 tarball 含可执行 `dist/src/index.js`，再从 tarball 安装并完成 MCP initialize/listTools smoke。
### Minor
1. **Windows cwd 和进程树语义未支持也未声明**
   - **用户现象**：Windows 上合法的 `C:\repo` 会被 `pi_spawn` 拒绝为非绝对路径；关闭 session 时也只 kill 直接 child，Pi 启动的工具进程可能残留。
   - **复现**：在 Windows 传入 drive-letter absolute cwd；`cwd.startsWith("/")` 为 false。进程停止路径在 Windows 回退为 `child.kill()`。
   - **位置**：`src/session/session-manager.ts:557`、`src/rpc/pi-rpc-process.ts:268`。
   - **最小修复**：使用 `path.isAbsolute` 并实现 Windows process-tree termination；若 MVP 明确仅支持 POSIX，则在 README/package metadata 中直接声明限制。
2. **发布产物缺少 MIT license 文本**
   - **用户现象**：npm 包声明 MIT，但仓库和 `files` 中没有 LICENSE，消费方无法从发布物获得许可全文。
   - **复现**：检查仓库和 pack 文件清单，无 `LICENSE*`。
   - **位置**：`package.json:10`、`package.json:28`。
   - **最小修复**：添加标准 MIT `LICENSE` 并确认其进入 tarball。
### Correct
- Claude Code 命令与 Codex TOML 的基本结构可用，且 README 已明确要求并发客户端使用不同 state dir，见 `README.md:24`、`README.md:42`、`README.md:54`。
- `content` 加 `isError: true` 符合 MCP SDK 的 `CallToolResult`；未声明 `outputSchema` 时不要求 `structuredContent`，见 `src/server.ts:129`。
- `switch_session.sessionPath`、`get_last_assistant_text`、`agent_settled` 和 `--model provider/id` 与本机安装的 Pi RPC 0.84.1 契约一致；未发现这些字段由 fake 自造。
- spawn/send 的逻辑 task/session ID、wait 去重和 any/all/timeout 主路径与设计一致。
## 缺失的高价值测试
- 真实 Pi RPC smoke：`get_state → prompt → agent_settled → get_last_assistant_text → switch_session`，可选模型调用单独启用。
- provider/auth/model runtime error 必须返回 `failed`，而不是空的 `completed`。
- 真实 stdio child-process 测试：stdin EOF 后 server、Pi 和工具子进程退出，manifest 为 clean。
- Pi 忽略 `abort` 时，close/shutdown 总耗时仍受 `shutdownGraceMs` 限制。
- 畸形协议且 child 忽略 SIGTERM 时，最终必须 SIGKILL，且恢复前确认旧进程退出。
- child stdin EPIPE 与 exit/error 并发时，MCP server 不崩溃且 task 只终结一次。
- model 参数精确 argv 断言及无效 model 的 MCP `isError` 结果。
- MCP 负面契约：未知 task/session、busy、schema validation、重复 task ID 和 timeout 边界。
- fresh checkout `npm pack`、从 tarball 安装、bin 执行和 MCP initialize/listTools。
- 若支持 Windows：drive-letter cwd 与真实 process-tree cleanup。
- 两个不同 state dir 的 Claude/Codex 实例隔离测试；共享目录仍是已文档化但未强制检测的残余风险。
未修改任何文件，也未运行 shell、Git 或测试命令。
