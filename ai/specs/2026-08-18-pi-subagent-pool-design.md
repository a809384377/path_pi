# 设计方案: 可复用的并行 Pi 子代理池

## 状态
定稿

## 日期
2026-08-18

## 背景与问题
Claude Code、Codex 等主 Agent 需要把独立编码任务派给 Pi，像调用 subagent 一样并行启动多个工作线程。每个 Pi 完成当前任务后要把最终回复交还主 Agent，但不能随任务结束而丢失上下文；主 Agent 应能继续向同一个 Pi session 派活，让它延续此前对代码和任务的理解。

现阶段只解决单机、单个 MCP 宿主生命周期内的并行与复用，并在宿主重启后恢复逻辑 session。它不是通用 Agent 调度平台。

## 目标 / 非目标

### 目标
- Claude Code、Codex 等 MCP Client 能创建 Pi session 并异步派发任务。
- 多个 Pi session 以独立进程并行工作；同一 session 内任务严格串行。
- 主 Agent 能等待任一或全部指定任务完成，并取得每个 Pi 的最终文本回复。
- 任务完成后 Pi 进程保持 idle，后续任务复用同一 AgentSession 上下文。
- MCP 宿主退出后不保活 OS 进程，但保留 Pi session 文件；下次按逻辑 `session_id` 懒恢复。
- 子进程异常退出、等待超时和显式关闭都有确定、可测试的结果。

### 非目标
- 宿主退出后继续执行未完成任务或保持 Pi 进程常驻。
- 独立 daemon、REST/Web UI、Redis/数据库、远程或多租户部署。
- 自动 worktree、文件锁、并行写冲突解决。
- 通用工作流、任务依赖图、Agent Mail、ACP、A2A 或 MCP Tasks。
- 支持 Pi 之外的 Agent backend。
- 将 Pi 的实时 token/tool stream 主动推送进主 Agent 对话。

## 设计决策

### D1: 使用 stdio MCP Server，不引入独立 daemon
- 选项: MCP Server 直接拥有 Pi 子进程 / MCP 前端连接常驻 daemon
- 决策: MCP Server 直接拥有 Pi 子进程。
- 理由: 当前只要求宿主存活期间真实常驻；逻辑 session 可由 Pi 原生文件恢复。daemon 会引入 IPC、进程发现、版本兼容和孤儿进程管理，超出 MVP。
- 影响: 宿主退出会终止所有 Pi 子进程和正在执行的任务；下次只能恢复 session 上下文，不能恢复正在执行的 task。

### D2: 一个逻辑 session 对应一个独立 Pi RPC 子进程
- 选项: 单进程内多个 AgentSession / 每个 session 一个 `pi --mode rpc` 进程
- 决策: 每个活跃 session 使用独立 Pi RPC 进程。
- 理由: 隔离 cwd、上下文、崩溃和 stdout 协议流；实现与 Pi 官方 RPC 模式直接对齐。
- 影响: 并发 session 数等于 Pi/模型并发数，资源开销高于单进程方案；MVP 通过配置限制最大活跃进程数。

### D3: 创建任务非阻塞，使用显式 `pi_wait` 回收结果
- 选项: `pi_spawn` 阻塞到完成 / 创建后靠主动 push / 创建立即返回并显式等待
- 决策: `pi_spawn`、`pi_send` 立即返回 `task_id`，主 Agent 使用 `pi_wait` 等待指定 task。
- 理由: MCP 工具调用不能在返回后可靠地再次向模型返回完成结果；显式 wait 与 subagent/subagent_wait 语义一致，也允许先并行启动多个 Pi。
- 影响: 工具说明必须要求主 Agent 在依赖结果时调用 `pi_wait`；MVP 不承诺无人等待时主动唤醒宿主模型。

### D4: Task 完成记录按 `task_id` 查询，不使用破坏性完成队列
- 选项: 消费型 completion queue / 每个 task 保存终态和 Promise
- 决策: 每个 task 有稳定 `task_id`、终态和可重复读取的完成结果；`pi_wait` 接受 task ID 列表。
- 理由: 避免多个 waiter 抢占同一结果、结果丢失或重复 wait 永久阻塞。`mode=any` 返回目标集合中已经完成或最先完成的 task，调用方从后续等待集合中移除已返回 task。
- 影响: MCP Server 生命周期内保留 task 记录；持久化只保存每个 session 的当前/最近任务摘要，不建设完整历史任务库。

### D5: 同一 session 不排队，busy 时拒绝新任务
- 选项: 自动 follow-up 队列 / busy 时允许 steer / 只接受无活跃任务的 session
- 决策: `pi_send` 只接受 `idle`、`dormant` 或已确认原进程退出的可恢复 `error` session；任何 dispatching/restoring/running 状态都返回 `session_busy`。
- 理由: 当前需求是“完成后继续派活”，不要求运行中干预；拒绝比隐式排队更容易推理和测试。为避免两个并发请求都通过状态检查，SessionManager 必须在第一次异步操作前同步预留 session 和 task。
- 影响: steer、follow-up 和保留 session 的单独 abort 操作推迟到后续版本。

### D6: Pi 原生 session 文件是真实对话存储，Gateway 只存映射元数据
- 选项: Gateway 复制消息历史 / 使用 Pi `sessionFile`
- 决策: 使用 Pi 默认 session 持久化；Gateway 原子写入小型 `sessions.json`。
- 理由: 避免重复实现上下文树、compaction 和消息格式；Pi RPC 已提供 `get_state`、`switch_session` 和 `get_last_assistant_text`。
- 影响: Gateway 持久化格式只包含逻辑 ID、Pi session 文件、cwd、名称、模型、生命周期状态和有限的最近 task 终态；session 文件损坏或丢失时该逻辑 session 进入 `error`。

### D7: 实现窄 Pi RPC transport，不直接依赖上游 `RpcClient`
- 选项: 使用 `@earendil-works/pi-coding-agent` 导出的 `RpcClient` / 实现仅覆盖本项目命令的最小 transport
- 决策: 直接启动可配置的 `pi` executable，并实现窄的 JSONL client；协议类型局部定义，只覆盖 `prompt`、`get_state`、`switch_session`、`get_last_assistant_text` 和 `abort`。
- 理由: 上游 `RpcClient` 虽是公开导出，但默认 CLI 路径依赖包目录，固定 readiness sleep，且不暴露足够的 child exit/error 生命周期；这些限制会让 crash、wait 和 deterministic fake-process 测试变复杂。
- 影响: 本项目必须自己正确处理严格 LF framing、RPC request correlation、超时、exit/error 和有界 stderr；不复制无关 RPC 命令包装。

## 技术方案

### 总体架构

```text
Claude Code / Codex
        │ MCP stdio
        ▼
Pi MCP Server
  ├── MCP tools
  ├── SessionManager
  ├── SessionStore (sessions.json)
  └── Task registry
        │
        ├── session A → PiRpcProcess A → Pi session JSONL A
        ├── session B → PiRpcProcess B → Pi session JSONL B
        └── session C → PiRpcProcess C → Pi session JSONL C
```

### 核心组件

#### MCP Server
- 使用官方 Model Context Protocol TypeScript SDK，通过 stdio transport 提供工具。
- stdout 只允许 MCP 协议输出；日志全部写 stderr。
- 注册并校验五个工具：`pi_spawn`、`pi_send`、`pi_wait`、`pi_status`、`pi_close`。

#### `PiRpcProcess`
- 通过可注入的 process factory 启动可配置的 `pi --mode rpc`，为每个逻辑 session 设置独立 cwd；生产默认使用 PATH 中的 `pi`。
- 启动后以成功的 `get_state` response 作为 readiness barrier，不依赖固定 sleep。
- 以严格 LF JSONL 解析 stdout，不能使用会额外按 Unicode 行分隔符切行的通用 readline 行为；使用 `StringDecoder` 保证跨 chunk UTF-8 完整。
- 为带 `id` 的 RPC command 维护 pending response map；无法关联的 parse/protocol error 必须显式失败，不允许静默等到超时。
- 将 Pi events 交给 SessionManager；监听器必须在发送 `prompt` 前安装，`agent_settled` 表示当前 task 真正结束。
- 子进程 exit/error 时拒绝 pending commands，并将当前 task 标记失败；completion wait 必须同时受进程退出驱动，不能只等 settled。
- stderr 进入有界诊断缓冲并可镜像到服务器 stderr，绝不能混入 JSONL stdout。

#### `SessionManager`
- 维护 `Map<session_id, SessionRecord>`。
- 一个 session 同时最多有一个 active task；生成新 `task_id` 并切入 `dispatching` 必须发生在任何 `await` 之前。
- 新 session 创建 Pi 进程并发送首个 `prompt`。
- dormant session 首次 `pi_send` 时原子切入 `restoring`，启动 Pi 进程，再用 `switch_session` 加载记录的 session 文件，并用 `get_state` 验证恢复结果。
- 收到 `agent_settled` 后调用 `get_last_assistant_text`，先持久化 task 终态，再唤醒 waiter，最后把 session 切为 `idle`，不终止子进程。
- 所有 task 终结都经过同一个 compare-and-set 路径；settled、close 和 process exit 中只有第一个事件能决定终态，迟到事件忽略。
- 子进程异常退出时，将 active task 标记 `failed`，session 切为可诊断的 `error`；只有已确认旧进程退出时，后续 `pi_send` 才能尝试恢复。

#### `SessionStore`
默认状态目录可配置，建议为 `~/.pi/agent-mcp/`：

```text
~/.pi/agent-mcp/
  sessions.json
```

记录结构示意：

```json
{
  "version": 1,
  "cleanShutdown": true,
  "sessions": {
    "pi_auth_01": {
      "generation": 3,
      "name": "auth-worker",
      "cwd": "/Users/me/project",
      "model": "openai/gpt-5.6",
      "piSessionId": "abc123",
      "sessionFile": "/Users/me/.pi/agent/sessions/...jsonl",
      "state": "idle",
      "activeTaskId": null,
      "lastTask": {
        "taskId": "task_01",
        "status": "completed",
        "response": "已完成……"
      }
    }
  }
}
```

写入采用临时文件加 rename，避免进程中断留下半个 JSON。状态目录只支持一个 MCP Server writer；多实例共享目录明确不支持。

MCP Server 启动时加载记录：
- 正常关闭留下的非 closed session 转为 `dormant`，不立即启动 Pi。
- 上次记录为非终态的 task 转为 `host_interrupted`，禁止自动重放，因为此前工具副作用可能已经发生。
- 对异常关闭遗留且旧进程所有权无法确认的 session，进入不可自动恢复的 `error`，避免两个进程写同一 Pi session 文件。
- server 启动时先将 `cleanShutdown` 写为 false；只有完成有界子进程清理的正常 shutdown 才写回 true。

### 状态与不变式

Session 状态：

```text
dormant ──pi_send──→ restoring → dispatching → running → idle
   ▲                     │             │          │       │
   └──── clean restart ──┘             └──────────┴──────→ error
idle ──pi_send──────────────────────→ dispatching
任何非 closed 状态 ──pi_close──→ closing → closed
```

Task 状态：

```text
dispatching → running → completed
                      ├→ failed
                      ├→ aborted（由 pi_close 导致）
                      └→ host_interrupted（宿主退出导致）
```

必须保持的不变式：
- 一个 session 最多有一个 Pi 进程和一个非终态 task。
- 检查可派发性、生成 task、占用 session 和切换 dispatching/restoring 在首个异步操作前同步完成。
- 一个活跃 Pi 子进程只属于一个 session。
- task 一旦进入终态不可再次改变；终态先持久化，再通知 waiter 或允许下一次 send。
- `pi_wait` 不消费或删除 task 结果；多个 waiter 可观察同一终态。
- waiter 采用“注册后重查”或集中 evaluator，避免检查和订阅之间丢失 completion。
- `agent_end` 不结束 task；只有 `agent_settled`、子进程失败、关闭或宿主中断结束 task。
- `idle` 表示驻留进程没有活跃 task；`dormant` 表示上下文可恢复但当前没有进程。
- shutdown 先拒绝新状态转换和新工具请求，再终结 active task，最后清理子进程。

### MCP 工具契约

#### `pi_spawn`
输入：
- `task`: 非空字符串，必填。
- `cwd`: 存在的绝对目录，必填。
- `name`: 可选显示名。
- `model`: 可选 Pi 模型选择。

输出：`session_id`、`task_id`、`status: running`。

#### `pi_send`
输入：`session_id`、非空 `task`。

行为：idle session 直接 prompt；dormant 或确认可恢复的 error session 先原子占位、恢复再 prompt；restoring/dispatching/running session 返回 `session_busy`。输出新 `task_id`。

#### `pi_wait`
输入：
- `task_ids`: 非空且去重后的 task ID 数组。
- `mode`: `any | all`，默认 `any`。
- `timeout_seconds`: 有上限的非负等待时间。

输出：
- `completed`: 已进入任意终态的 task 记录，包含 `session_id`、`task_id`、`status`、`response` 或 `error`。
- `pending`: 尚未终结的 task ID。
- `timed_out`: 是否因超时返回。

`mode=any` 在至少一个目标 task 终结时返回当前已终结目标；`mode=all` 在全部目标终结时返回。调用开始时对 ID 去重并验证未知 ID；空集合直接报参数错误。订阅 completion 后必须重查一次状态，避免竞态。超时取消 timer/listener，返回当时终态子集但不改变 task；超时不是 task 失败。

#### `pi_status`
可选输入 `session_id`。传入时返回单个 session；省略时返回所有非 closed session。至少包含名称、cwd、状态、是否驻留、当前 task、最近 task 和可恢复性。

#### `pi_close`
输入 `session_id`。如果 task 正在执行，先原子切入 `closing` 并终结 active task 为 `aborted`、唤醒 waiter，再发送 RPC `abort`；在有限宽限期后终止 Pi 进程并必要时强杀。process exit 迟到事件不能把 aborted 改成 crashed。逻辑 session 标记 `closed`，Pi 原生 session 文件默认保留。实现需验证关闭 Pi 时其正在执行的工具子进程也被终止。

### 典型时序

```text
主 Agent        MCP Server       Pi A              Pi B
   │ pi_spawn A      │             │                 │
   ├────────────────>│──prompt─────>│                 │
   │<─sidA/taskA─────│             │                 │
   │ pi_spawn B      │             │                 │
   ├────────────────>│──prompt───────────────────────>│
   │<─sidB/taskB─────│             │                 │
   │ pi_wait any     │             │                 │
   ├────────────────>│             │                 │
   │                 │<─settled B────────────────────│
   │<─result B───────│             │                 │
   │ pi_send sidB    │             │                 │
   ├────────────────>│──prompt───────────────────────>│
   │<─taskB2─────────│             │                 │
   │ pi_wait ...     │             │                 │
```

## 成功标准
- [ ] Claude Code 或 Codex 能通过 stdio MCP 调用全部五个工具。
- [ ] 连续启动至少三个 Pi session 时能并行运行，互不串线。
- [ ] `pi_wait(any)` 能返回首先完成的 task，`pi_wait(all)` 能返回全部指定 task；超时可继续等待。
- [ ] 同一 session 完成后保持 idle，`pi_send` 的下一项任务能引用前一轮上下文。
- [ ] running session 上的第二次 `pi_send` 被确定性拒绝。
- [ ] Pi 子进程异常退出时 task 失败且其他 session 不受影响。
- [ ] MCP Server 重启后能列出历史 session，并在下一次 `pi_send` 时通过 Pi session 文件恢复上下文。
- [ ] MCP Server 正常退出时不会留下其拥有的 Pi 子进程；异常 SIGKILL 不承诺恢复正在运行的 task。
- [ ] 单元测试覆盖 JSONL 分帧、状态转换、wait any/all/timeout、多 waiter、崩溃和恢复；至少一个集成测试使用可控的 fake Pi RPC 子进程验证完整流程。

## 范围
- 包含: TypeScript MCP stdio server、Pi RPC subprocess client、SessionManager、轻量 session store、五个 MCP tools、单元/集成测试、Claude Code/Codex 配置示例。
- 不包含: daemon、UI、网络服务、任务历史数据库、实时事件展示、运行中 steer/follow-up、自动 Git 隔离和跨 Agent 编排。

## 实现期重点清单
- [ ] 严格按 LF 拆分 JSONL，并处理 chunk 截断、多个 frame、CRLF、EOF 残片和畸形 JSON。
- [ ] `prompt` 的 response 只代表接受；不得把它当成任务完成。
- [ ] `agent_settled` 与随后 `get_last_assistant_text` 的竞态和错误路径有测试。
- [ ] task 先完成、后调用 wait 时立即返回；多个并发 waiter 不抢占结果；检查与订阅之间完成也不丢失。
- [ ] 两个并发 `pi_send` 只有一个能在同一 session 上取得预留权。
- [ ] close、进程 exit 和 agent_settled 同时发生时，task 只完成一次。
- [ ] MCP shutdown 在 transport close、stdin EOF、SIGINT 和 SIGTERM 上先拒绝新请求，再对所有 Pi 子进程执行有限宽限期清理，最终确保 kill；不依赖 `beforeExit`。
- [ ] sessions.json 使用原子写并校验 schema/version；丢失的 cwd/sessionFile 给出可诊断错误。
- [ ] 从上次异常退出遗留的 `running` 状态恢复时，不宣称原 task 仍在运行。
- [ ] stdout 零日志污染；所有诊断信息走 stderr。
- [ ] 测试不调用真实模型 API；真实 Pi smoke test 作为可选命令。

## 风险与未决
- 多个 session 指向同一 cwd 时可能同时修改同一文件；MVP 明确由主 Agent 分配互不冲突的任务或不同 cwd。
- MCP Client 对单次工具调用有超时；`pi_wait` 必须允许短超时后重复调用，而不是假设可永久阻塞。
- 平台级 SIGKILL、内核故障或机器断电可能留下短暂孤儿进程；没有 daemon/lease 时无法证明旧进程所有权，异常关闭后的 dirty session 应安全拒绝自动恢复，而不是冒险双写。
- `sessions.json` 是单 writer 清单；同时启动两个共享同一状态目录的 MCP Server 不受支持，Claude Code 与 Codex 同时使用时应配置不同状态目录。
- Pi session 文件格式和 RPC command 属于上游接口；实现应把协议与恢复逻辑集中封装，避免依赖扩散。
