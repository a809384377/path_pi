## Review
- **Correct:** 当前 `HEAD` 指向 `9db6b4be8bcbaa6ffdf0d20b9a13e30ee855aedf`。审查仅依据冻结 spec、Sprint brief、实际源码和测试，未读取实现过程记录。
- **Correct:** 同一 session 的并发 `send` 在首次 `await` 前同步检查并设置 `activeTaskId/state`，两个请求不能同时取得所有权，见 `src/session/session-manager.ts:160`；对应测试在 `test/session-manager.integration.test.ts:115`。
- **Correct:** 普通 spawn 之间的容量检查和 session 插入没有 `await`，因此未发现直接的 spawn/spawn 超配窗口，见 `src/session/session-manager.ts:127`。
- **Correct:** `wait` 使用“注册 listener 后重查”，结果不消费，常规 any/all/timeout 和多 waiter 逻辑正确，见 `src/session/session-manager.ts:190`、`test/session-manager.integration.test.ts:132`。
- **Correct:** 未知 response ID 会立即触发协议失败，而不是等待超时，见 `src/rpc/pi-rpc-process.ts:222`。
### Blocker
1. **stdin EOF 不触发 MCP shutdown，正常宿主断开会留下 dirty manifest 或驻留子进程（spec 内）**
   **现象：** `runStdioServer` 只依赖 `transport.onclose` 和信号；SDK 的 `StdioServerTransport.start()` 只监听 stdin 的 `data/error`，不监听 `end/close`。单纯关闭 MCP stdin 不会调用 `manager.shutdown()`。无 Pi 子进程时 Node 可能直接退出并遗留 `cleanShutdown:false`；存在 Pi 子进程时其管道会使 server 和子进程继续驻留。
   **最小复现：** 以子进程启动 MCP server，创建并等待一个 idle Pi session，然后只关闭父进程持有的 stdin 写端且不发送信号；等待超过 `shutdownGraceMs`，server PID 和 fake Pi PID 仍存在，`sessions.json.cleanShutdown` 仍为 false。即使不创建 session，关闭 stdin 后 manifest 也不会被正常标为 clean。
   **位置：** `src/server.ts:109`、`src/server.ts:123`、`node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js:32`
   **最小修复：** 显式监听 `process.stdin` 的 `end` 和 `close`，统一调用同一个幂等 shutdown promise；增加真实 stdio 子进程测试，关闭写端后断言 server、Pi 及工具子进程退出且 manifest clean。
2. **协议失败和 stop 都可能在 OS 进程尚存时丢弃所有权，随后恢复会双进程写同一 session（spec 内）**
   **现象：** `#protocolFailure` 发送一次 SIGTERM 后立即调用 `#handleTermination`，清空 `#child`、解析 exit promise 并发出逻辑 `exit`，但没有等待真实 exit，也不会执行 SIGKILL。若 Pi 忽略 SIGTERM，SessionManager 会把它视为已退出且可恢复，下一次 `send` 能启动第二个进程。正常 `stop()` 在 SIGKILL 后也只等待 100ms；即使从未收到 exit，仍正常返回，shutdown 随后写 `cleanShutdown:true` 并清除 manager 对 process 的引用。
   **最小复现：** 使用一个能正确响应 readiness、但忽略 SIGTERM 并在之后输出未知 response ID 或畸形 JSON 的 fake Pi。协议错误后检查旧 PID 仍存活；随后对该 error session 调用 `send`，可观察到第二个 PID 恢复同一 `sessionFile`。另一复现是令 fake child 的 `kill()` 返回 false 且永不发 exit：`shutdown()` 仍返回并写 clean manifest。
   **位置：** `src/rpc/pi-rpc-process.ts:141`、`src/rpc/pi-rpc-process.ts:238`、`src/rpc/pi-rpc-process.ts:244`、`src/session/session-manager.ts:273`、`src/session/session-manager.ts:282`
   **最小修复：** 建立单一 termination 状态机；协议错误只记录原因、拒绝 pending 并启动 TERM→grace→KILL，只有收到真实 `exit/close` 后才清空 child、解析 exit promise、通知 manager。强杀后仍未确认退出应让 `stop()` 失败；manager 不得清 process ownership、标 recoverable 或写 clean shutdown。
### Major
1. **spawn 在首个 await 前未预留，能越过已经完成的 shutdown（spec 内）**
   **现象：** `spawn()` 只在异步 `stat(cwd)` 前检查一次 `#shuttingDown`。如果 shutdown 在 stat 等待期间开始并完成，spawn 恢复后不会重查，而会创建 session、持久化并启动新 Pi。此时 shutdown 已不会再清理该进程，manifest 甚至可能保持 `cleanShutdown:true` 和 `running` session。
   **最小复现：** 在 `src/session/session-manager.ts:126` 的 `stat` 返回前暂停请求（慢速/FUSE cwd，或测试中注入 deferred cwd validator），调用并等待 `manager.shutdown()`，再释放 stat；原 spawn 会继续创建 session/process，而不是返回 `server_shutting_down`。
   **位置：** `src/session/session-manager.ts:124`、`src/session/session-manager.ts:126`、`src/session/session-manager.ts:127`
   **最小修复：** 在 cwd 校验返回后再次同步调用 `#assertAvailable()`，紧接着完成容量检查和 reservation，中间不得 `await`；更完整的方案是跟踪并取消/等待所有已进入的状态变更请求。
2. **并发 close 与 shutdown 可把 closed session 重新写成 dormant（spec 内）**
   **现象：** 两条路径都可捕获同一个 rpc 并跨多个 await 继续执行。若 `close()` 先在 `src/session/session-manager.ts:255` 写入 `closed`，较晚恢复的 shutdown 会在 `src/session/session-manager.ts:277` 无条件覆盖为 `dormant/error`。正常重启后，被明确关闭的逻辑 session 会重新出现并可恢复。
   **最小复现：** 对 idle session 同时调用 `close()` 和 `shutdown()`；用可控 rpc 令 close 的 abort/stop 先完成、shutdown 的 stop 后完成。close 返回 `state:"closed"`，但最终 manifest 中同一 session 为 `dormant`，下次 initialize 后可再次 `send`。
   **位置：** `src/session/session-manager.ts:237`、`src/session/session-manager.ts:249`、`src/session/session-manager.ts:255`、`src/session/session-manager.ts:261`、`src/session/session-manager.ts:271`、`src/session/session-manager.ts:277`
   **最小修复：** 将 close/shutdown/exit 收敛到按 session 串行化的生命周期操作；至少给 closing 记录原因/epoch，并在每个 await 后 CAS 验证所有权，shutdown 不得覆盖已经进入 `closed` 的 session。
3. **任务终态在持久化完成前已对新 waiter 和下一次 send 可见（spec 内）**
   **现象：** `#finalizeTask` 在 `await #persist()` 前同步设置 terminal status、清空 active task 并把 session 切为 idle。已注册 waiter 直到 save 完成后才收到事件，但此窗口中新调用的 `wait()` 会立即返回 completed，新 `send()` 也能占用 session。若写盘失败或此时崩溃，调用方已经观察到“完成”，但 durable manifest 没有该终态；持久化失败还会使旧 waiter 没有 terminal event。
   **最小复现：** 使用一个在 final save 上阻塞的 `JsonSessionStore` 子类，触发 `agent_settled` 后、释放 save 前调用 `wait(task, 0)` 和 `send(session, ...)`；前者立即返回 completed，后者开始 dispatch。随后模拟进程崩溃或让 save reject。
   **位置：** `src/session/session-manager.ts:203`、`src/session/session-manager.ts:396`、`src/session/session-manager.ts:404`、`src/session/session-manager.ts:405`
   **最小修复：** 增加 runtime-only `finalizing/published` latch：CAS 后允许构造持久化快照，但 wait 只观察 published terminal，send 在 finalizing 时拒绝；save 成功后再原子发布、允许 send 并 emit。save 失败时保持 session 不可派发并报告存储故障。
4. **`agent_settled` 可先于 prompt acceptance，导致 spawn/send 报错但内部任务已 completed（spec 内）**
   **现象：** manager 在等待 `rpc.prompt()` response 前已经把 task 标为 running；settled handler 可立即读取最终文本并完成任务。如果随后 prompt response 为失败、command mismatch 或 timeout，dispatch 路径仍抛错并停止进程，但 `#failDispatch` 因任务已 terminal 不会改回 failed。调用方得到工具错误且没有 task ID，内部却保留 completed task。
   **最小复现：** fake Pi 收到 prompt 后先发送 `agent_settled`，响应 `get_last_assistant_text`，最后给原 prompt 返回 `success:false`；`spawn()` rejects，但 manager 内任务状态为 completed。将最后一步改为不响应，可在命令超时后得到相同矛盾。
   **位置：** `src/session/session-manager.ts:314`、`src/session/session-manager.ts:318`、`src/session/session-manager.ts:343`、`src/session/session-manager.ts:349`
   **最小修复：** 为 task 记录 prompt acceptance phase；listener 仍需预先安装，但 acceptance 前到达的 settled 只做 pending 标记。prompt success 后再处理 pending settled；prompt failure 必须先 CAS 为 failed，迟到 settled 忽略。
5. **close/shutdown 可在 abort response 上等待完整 command timeout，清理宽限期失效（spec 内）**
   **现象：** 两条关闭路径先 `await rpc.abort()`，其 timeout 使用默认 30 秒，之后才调用带 1 秒 grace 的 `stop()`。一个仍存活但不响应 RPC 的 Pi 会让单 session shutdown 卡住 30 秒；多个 session 又按顺序处理，最坏时间线性累加。
   **最小复现：** fake Pi 正常响应 readiness/prompt，但忽略 abort response；配置 `commandTimeoutMs=30_000`、`shutdownGraceMs=100`，调用 `close()` 或 `shutdown()`，约 30 秒后才首次发送 SIGTERM。
   **位置：** `src/session/session-manager.ts:251`、`src/session/session-manager.ts:273`、`src/rpc/pi-rpc-process.ts:137`、`src/rpc/pi-rpc-process.ts:173`
   **最小修复：** abort 只能使用独立且不超过 shutdown grace 的短 deadline；deadline 后立即进入 stop。shutdown 应并行清理各 session，并设置整体有界 deadline。
6. **结构畸形的 response 被当作普通 event 静默忽略，最终只报 timeout（spec 内）**
   **现象：** `isRpcResponse` 对缺少 `command/success` 的 response 返回 false，随后 `#consumeLines` 因其仍有字符串 `type:"response"`，把它作为 generic event emit。SessionManager 忽略该 event，pending request 一直等到 timeout。现有测试只覆盖不可解析 JSON，没有覆盖可解析但 shape 错误的 response。
   **最小复现：** 对 pending prompt 写入 `{"id":"rpc_2","type":"response","command":"prompt"}`，省略 `success`；不会立即产生 protocol failure，而是在 `commandTimeoutMs` 后报 timeout。
   **位置：** `src/rpc/types.ts:45`、`src/rpc/pi-rpc-process.ts:196`、`src/rpc/pi-rpc-process.ts:206`、`src/rpc/pi-rpc-process.ts:208`、`test/pi-rpc-process.test.ts:91`
   **最小修复：** 先按 `type` 分流；`type === "response"` 时必须严格验证完整 response schema，失败立即 protocol-fail。event 也应使用明确 schema/允许列表，不能让 `"response"` 落入 generic event 分支。
7. **Windows 只杀 Pi 根进程，不杀工具子进程树（spec 内）**
   **现象：** POSIX 使用 detached process group 和负 PID kill，现有测试能验证该路径；Windows 分支只调用 `child.kill(signal)`，Pi 启动的工具子进程不会被终止。设计没有把 Windows process-tree cleanup 列为非目标，README 也未限制平台。
   **最小复现：** Windows 上让 fake Pi 启动一个长期运行的工具子进程，再调用 `pi_close` 或 shutdown；Pi 根进程退出后，工具子进程 PID 仍存活。
   **位置：** `src/rpc/pi-rpc-process.ts:92`、`src/rpc/pi-rpc-process.ts:268`、`test/session-manager.integration.test.ts:230`
   **最小修复：** Windows 使用 Job Object，或 `taskkill /PID <pid> /T /F` 等可验证的整树终止机制，并增加平台测试；若不支持 Windows，必须作为明确范围限制变更设计和文档，不能继续声称 process-tree guarantee。
### Minor
未发现可独立定级为 Minor 的并发、进程或生命周期问题。
### 范围区分
- 以上问题均落在冻结 spec 的明确目标或不变式内，不是功能扩展建议。
- 未将宿主遭受 SIGKILL 后继续任务/可靠回收孤儿进程列为问题；这是明确非目标。
- 未将共享 state 目录的多 writer、多个 session 同 cwd 的写冲突、daemon 保活列为问题；这些也是明确非目标。
- 现有测试验证了常规并发 send、wait、多 waiter、普通 crash、late-settled-after-close、POSIX 进程组清理和 clean restore，但没有覆盖上述对抗时序。
