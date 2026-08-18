# 设计方案: Shared Pi Session Registry v2

## 状态
定稿（用户于 2026-08-18 确认；设计内容冻结于 commit `1a54d72`）

## 日期
2026-08-18

## 替代关系
本 spec 只替代 v1 设计 `ai/specs/2026-08-18-pi-subagent-pool-design.md` 中的 D6、`SessionStore`、重启恢复和多 MCP Server 存储边界。五个 MCP 工具、Pi RPC transport、task/wait 状态机、process-group cleanup 等其余冻结决策继续有效。

## 背景与问题
v0.1.0 使用一个 `sessions.json` 保存全部逻辑 session。Claude Code 与 Codex 分别启动 stdio MCP Server 时会产生两个独立 writer；若共享该文件，最后一次全量 rename 可能覆盖另一个进程创建或更新的 session。因此 README 要求两者配置不同 `PI_AGENT_MCP_STATE_DIR`。

这不是 MCP 的必然限制。目标是在保留 Pi 原生 JSONL 对话和宿主重启后懒恢复能力的同时，让多个 MCP Server 默认共用统一状态根目录。

Pi 原生 JSONL 是对话内容的事实源；gateway record 只保存调度与发现元数据：逻辑 ID、cwd、名称/模型、Pi native ID/path、task 状态和最近结果。

## 目标 / 非目标

### 目标
- Claude Code、Codex 等调用方默认共用 `~/.pi/agent-mcp/`，无需按调用方拆状态目录。
- 不同 MCP Server 可同时创建、运行和恢复不同 Pi session，record 更新互不覆盖。
- 遵守本协议的进程中，同一逻辑 session 和同一 Pi 原生 session 同时最多一个 Pi writer。
- owner 正常退出后，另一 MCP Server 可立即懒恢复；owner 异常死亡后严格 fail-closed，旧 Pi writer 消失前绝不偷锁。
- v1 manifest 可安全、幂等地汇总到 canonical root；旧数据不删除，冲突不覆盖。
- 保持五工具名称、输入 schema 和既有单进程行为；跨 Server status/send/close 有确定语义。

### 非目标
- 两个 MCP Server 同时操作同一 session。
- 一个 owner 仍存活时强制抢占或在线移交 session。
- 正在执行 task 的跨进程迁移或自动重放。
- 跨 MCP Server 通过 `pi_wait` 等待另一个 Server 创建的 task。
- 保护不遵守 ownership 协议的独立 Pi TUI/第三方程序。
- daemon、网络服务、跨机器/NFS/SMB、Windows、敌对同 UID 进程。
- 自动合并语义冲突的 legacy records。

## 设计决策

### D1: 统一 canonical root + per-session records
- 决策: 默认 root 为 `~/.pi/agent-mcp/`；每个 session 使用独立 JSON record。
- 理由: 不同 session 不共享写热点，不需要 SQLite/daemon。
- 影响: `PI_AGENT_MCP_STATE_DIR` 保留为高级隔离/测试覆盖项；显式非默认 root 永远是独立 registry，不能参与自动 legacy consolidation。

### D2: 保留 gateway ID，同时由 gateway 预分配 Pi native ID
- 决策: MCP 继续公开 `pi_<uuid>`；`pi_spawn` 在启动 Pi 前另生成 Pi-compatible UUID native ID，先建立完整 ownership，再用 `pi --session-id <native-id> --mode rpc` 启动。
- 理由: 保持 v0.1 API；Pi 0.84.1 支持 `--session-id` 并在真正持久化时用 `wx` 创建 JSONL，因此 native ownership 不再有“先启动写文件、后知道 ID”的窗口。
- 影响: 新 session 不再接受 Pi 自行随机 native ID。启动后必须验证 `get_state.sessionId` 等于预分配 ID。

### D3: 使用固定版本的 kernel `flock` dependency
- 决策: 固定 `fs-ext-extra-prebuilt@2.2.12`（MIT，lockfile integrity 锁定），端到端只支持 macOS/Linux x64/arm64、Node `>=22.19 <26`；加载失败 hard fail，不降级为 lease/PID lock。
- 证据: 包含上述平台与 Node 22–25 主版本的预构建 `.node`；Darwin arm64/Node 23 clean install 与 `exnb` PoC 已通过。最低 Node 与当前 Pi 0.84.1 的 `>=22.19.0` requirement 对齐。
- 影响: `package.json.engines` 改为 `>=22.19 <26`；最终发布前用 CI/clean runners验证声明矩阵。依赖安装或加载错误必须给出 `ownership_unavailable` 和支持矩阵。

### D4: ownership 是 logical ID + 文件实际 Pi native ID
- 决策: established session先只读打开并解析 Pi JSONL session header，以文件内容中的实际 native ID（不是 record 声称值）获取 native lock；new session使用 gateway预分配并传给 `--session-id` 的 native ID。每个 resident session只需 logical + actual-native 两把 kernel locks。
- 理由: hardlink、复制文件或损坏 record即使 path/record metadata不同，session header仍使它们收敛到同一 native lock；避免无法继承的 late path/inode locks扩大协议。
- 影响: keys用 domain-separated SHA-256；始终 logical→native non-blocking获取，失败逆序释放。existing file在启动前以 `open(O_RDONLY|O_NOFOLLOW)` + `fstat` + header parse独立导出 native ID，并要求它等于 record；path `lstat` identity须与opened fd一致。

### D5: logical 与 actual-native lock FD 同时由 MCP 和 Pi 子进程持有
- 决策: ownership fd 作为额外 stdio fd 传给 Pi 子进程继承；MCP 与 Pi 都持有同一 flock open-file description。只有 process group 全部退出并且 MCP 关闭自身 fd 后，ownership 才释放。
- 理由: Pi 当前以 detached process group 运行；仅父 MCP 持锁会在父 `SIGKILL` 后留下无锁 orphan writer。
- 证据: Darwin arm64 PoC 证明父被 `SIGKILL` 后，继承 fd 的 child 仍阻止第二进程 `exnb`；child 退出后锁自动释放。
- 影响: 正常 shutdown 先清理 Pi group、durable publish、drain write queue，再 close locks。异常父死亡但旧 Pi 存活时，新 MCP 得到 `session_in_use`；不通过 PID/时间戳偷锁。若 orphan 永久不退，用户需终止该 Pi process group，这是严格 fail-closed 的代价。

### D6: 恢复不使用 write-capable `switch_session`
- 决策: established session 在启动前验证和锁定 record 指向的 Pi 文件，然后直接以 `pi --session <absolute-file> --mode rpc` 启动；不先启动空 session再调用 `switch_session`。
- 理由: post-switch 验证不能防止错误 record 在验证前写入被占用文件。
- 影响: 启动后用只读 `get_state` 验证 native ID、reported path 与已锁定 identity；不一致立即终止，标记 error但不自动修 record。

### D7: per-record `revision` 串行化所有 durable mutations
- 决策: `revision` 每次 record mutation +1；`generation` 只代表 task generation。每个本地 owned session 有单一 write queue，update 使用 expected revision；release 前必须 drain/cancel queue。
- 理由: 同一 task generation 内也会经历 running、terminal、dormant、closed，多次异步写不能互相回滚。
- 影响: create 使用 temp fsync + atomic hard-link no-replace + temp unlink + directory fsync；owned update 才允许 atomic rename-overwrite。

### D8: per-record crash state，不自动重放
- 决策: 没有全局 `cleanShutdown`。dispatch 前先持久化 active task；正常关闭持久化 dormant/closed再释放。新 owner 获取完整 locks 后若看见 running/active task，将其变为 `host_interrupted`，不重放，然后才允许新 task。
- 影响: 一个 Server 崩溃只污染其 owned records。若 lock 仍被 orphan Pi 持有，不能提前解释或修改该 record。

### D9: v1 migration 是 canonical-root、source-atomic consolidation
- 决策: 只有未显式设置 `PI_AGENT_MCP_STATE_DIR` 的 canonical root Server执行自动迁移；对每个 source 完整 preflight，任一 conflict/uncertainty 则整个 source 不退休、不激活。
- 理由: 旧 caller-specific roots 各自升级会形成两个 v2 lock namespace，无法解决共享问题；partial activation让冲突恢复复杂化。
- 影响: 升级指南要求先关闭 Claude/Codex、移除两边旧 state-dir 环境变量，再启动一个 v2 Server完成 consolidation。

### D10: 动态磁盘 status；`pi_wait` 只覆盖 current/last task
- 决策: 内存 Map只包含本进程拥有的 sessions/tasks；`pi_status` 每次读取磁盘 records并仅对持有live locks且revision匹配的本地session叠加runtime。`pi_wait` 对本地task保持事件驱动；对磁盘任一record的精确 `lastTask.taskId` 可直接返回terminal result，对精确 `activeTaskId` 只轮询该record至terminal/timeout。
- 理由: status必须看见其他Server新建的sessions；只支持record现有current/last槽位即可保持v1重启后的wait能力，无需task历史库、tombstone或过期分类。
- 影响: 不在current/last槽位的task ID返回现有 `unknown_task`。remote active task的owner crash但旧Pi仍持锁时可如实保持pending；锁已释放时waiter可non-blocking取得logical+actual-native locks、fresh-read并durable发布 `host_interrupted`，不启动Pi，然后释放。

## 技术方案

### 目录布局

```text
~/.pi/agent-mcp/
  sessions/
    <logical-hash>.json
  pi-sessions/
    <logical-hash>/               # v2 new sessions 的独占 Pi --session-dir
  locks/
    logical-<hash>.lock
    native-<hash>.lock
    migration-source-<hash>.lock
  migrations/
    v1-<path-and-content-hash>/
      source.json
      intent.json
      receipt.json
      conflicts.json
  tmp/
```

root/subdirectories mode `0700`，record/lock mode `0600`。文件名均为 domain-separated SHA-256。支持边界是 cooperative processes + 当前用户私有 root：逐层拒绝 symlink，open 后比较 `lstat` 与 `fstat` identity；不承诺抵御恶意同 UID rename/replacement。

### Session record v2

```ts
interface SessionRecordV2 {
  version: 2;
  sessionId: string;
  revision: number;
  generation: number;

  name?: string;
  cwd: string;
  model?: string;

  piSessionId?: string;
  sessionFile?: string;

  state: "creating" | "dormant" | "idle" | "running" | "error" | "closed" | "migration_blocked";
  recoverable: boolean;
  activeTaskId: string | null;
  lastTask?: StoredTask;

  migration?: {
    migrationId: string;
    sourcePath: string;
    sourceHash: string;
    sourceSessionHash: string;
  };

  updatedAt: string;
}
```

规则：
- `sessionId` 必须与文件名 hash 匹配。
- `revision` 每次 mutation递增；`generation` 只在新 task durable publication时递增。
- `sessionFile`是absolute intended/actual path；`recoverable`只有在该文件通过严格首行identity验证后才可为true。established session必须同时具备native ID、path与`recoverable: true`。
- gateway identity parser只读取第一物理行，最大`64 KiB`（含换行），要求它是session header JSON：`type === "session"`、受支持的整数`version`、合法非空`id`、绝对`cwd`；拒绝blank/malformed/超长首行。后续entries不参与identity解析，由Pi自身loader负责；即使后文出现异常或重复header，也不能改变第一行导出的actual-native lock key。v1 imported Pi files也必须通过同一严格首行验证，不能复制Pi loader跳过malformed首行的宽松行为。
- owner diagnostics只写 lock file，不能作为释放或 stale依据。
- crash留下`creating`或`running/recoverable:false`时走专用reconciliation，不进入普通established restore：获取logical lock后，以record中的预分配native ID获取native lock；fresh revision验证后，要求intended path仍位于该record的exclusive session dir。若文件存在且严格首行identity有效/匹配，则单次revision把active task存为`host_interrupted`、清空`activeTaskId`、置`dormant/recoverable:true`，之后才可普通恢复；若文件不存在或无效则置`error/recoverable:false`，不得启动Pi。

### RecordStore

```ts
interface SessionRecordStore {
  create(record): Promise<void>; // atomic no-replace
  read(sessionId): Promise<SessionRecordV2>;
  updateOwned(sessionId, expectedRevision, next): Promise<void>;
  list(): Promise<SessionRecordV2[]>;
}
```

- create: 私有 temp `wx` → write/fsync → `link(temp, final)` 作为 no-replace publication → unlink temp → fsync directory。
- updateOwned: 仅完整 logical ownership holder可调用；expected revision mismatch fail；同目录 temp + fsync + rename-overwrite + directory fsync。
- 每 session mutation排入单一 queue；close/shutdown/release等待 queue drain。
- list忽略 temp；任一 final record损坏时返回带路径诊断，不伪装成完整成功列表。

### Ownership 获取与 lifecycle

#### New session
1. 生成gateway ID与Pi-compatible native UUID，计算gateway私有 `pi-sessions/<logical-hash>/`。
2. 获取logical与native locks；以`0700` no-symlink规则创建/打开该session dir，并要求目录为空。非空一律fail closed，不启动Pi。
3. create `creating` record，包含native ID与exclusive session dir但暂无session file。
4. 以 `--session-dir <exclusive-dir> --session-id <native-id> --mode rpc` 启动Pi，并把两把lock fds传为额外inherited stdio。该空目录只对应一个logical session，因此`--session-id`不可能打开其他现有Pi文件。
5. `get_state`必须回报预分配native ID，且absolute intended path必须位于exclusive dir并继续为`ENOENT`；任何已存在path或不一致立即终止且不发送prompt。
6. durable bind intended path为`running`但`recoverable: false`后才发送prompt。Pi首次持久化以`wx`创建文件；一旦文件出现，在把session发布为`recoverable:true`或`dormant`前，必须用严格首行parser验证header actual native ID与record一致。task的terminal `lastTask`结果本身总可durable发布；若task结束仍未创建有效文件，session必须置`error/recoverable:false`，不得置dormant或普通恢复。


#### Crash reconciliation
1. 对`creating`或`running/recoverable:false` record，先获取logical lock，再根据record中预分配native ID获取native lock；fresh-read并验证revision/ID未变。
2. 验证record声明的exclusive session dir属于canonical `pi-sessions/<logical-hash>/`且无symlink，intended path直接位于该目录。
3. path存在且严格首行actual native ID匹配时，原子发布active task=`host_interrupted`（若有）、清空`activeTaskId`并置`dormant/recoverable:true`；随后可按Established session流程恢复。
4. path为`ENOENT`、越界、symlink、非regular或header不匹配时，原子置`error/recoverable:false`并保留诊断；不启动Pi，不删除可能的数据。

#### Established session
1. 获取logical lock，fresh-read record并拒绝closed/migration_blocked/corrupt/incomplete creating。
2. `open(O_RDONLY|O_NOFOLLOW)` session file，`fstat`确认regular；从opened fd严格解析首个session header得到actual native ID，要求等于record。用`lstat`再次确认path仍指向opened identity。
3. 获取actual native lock，fresh-read并验证revision未变，再复核path/opened identity未变。
4. 以 `--session <path> --mode rpc` 启动Pi，两把locks作为inherited fds。
5. `get_state`验证native ID/path；不执行`switch_session`。
6. 若旧record为running，在完整ownership下durable publish `host_interrupted`；开始新generation并发送prompt。

#### Release
- graceful close/server shutdown: 停止/杀死并确认完整Pi process group退出 → publish terminal+dormant/closed record → drain queue → 只close MCP lock fds。实现不得在任何Pi descendant可能存活时调用显式`LOCK_UN`，因为unlock会作用于共享open-file description。
- MCP crash/SIGKILL: MCP fds关闭，但Pi继承的logical/native fds继续持锁；旧Pi退出后内核自动释放。
- process-group退出无法确认: 不 close MCP fds；shutdown报告失败。若宿主随后强杀 MCP，旧 Pi仍持有继承锁并 fail-closed。
- lock files永不unlink；graceful release在已确认Pi process group退出后只close MCP descriptors，不调用显式`LOCK_UN`。

### 多 Server 五工具语义

- `pi_spawn`: 不同 sessions可并行；极端 native/path key冲突时一个返回 in-use且不发送 prompt。
- `pi_send`: 从磁盘找record；普通record获取完整ownership后恢复；`creating`或`running/recoverable:false`先执行Crash reconciliation。被其他MCP或orphan Pi持有时返回`session_in_use`。
- `pi_status`: 不抢锁、不启动 Pi。remote `resident` 只能为 `unknown`；`ownership` 是 `local | other | free_or_unknown` 的瞬时诊断，不作授权。
- `pi_wait`: 本地task保持event-driven；remote/current task只轮询对应record，lastTask可直接返回。结果被后续task覆盖后仍按既有规则返回`unknown_task`，不建立历史库。
- `pi_close`: 从磁盘找record。若live owner持有则`session_in_use`；free dormant/error session在获取logical+actual-native ownership并fresh revision验证后直接durable close，不启动Pi；free running record在同一原子revision中把active task保存为`host_interrupted`、清空`activeTaskId`并置closed，也不启动Pi；本地resident则先终止task/process再close。
- owner正常退出后，另一 Server下一次 send可恢复。异常退出时，仅在旧 Pi也退出、全部 locks可得后才可恢复和发布 `host_interrupted`。

### v1 migration

#### Source discovery
canonical root启动时按以下顺序处理：
1. 先枚举 `migrations/*/intent.json` 中无completed receipt的事务，恢复完所有已退休或已进入publication阶段的迁移。
2. 再检查新的live v1 sources：canonical root、`~/.pi/agent-mcp-claude/`、`~/.pi/agent-mcp-codex/`及`PI_AGENT_MCP_LEGACY_STATE_DIRS`下的`sessions.json`。

不扫描整个home。migration ID = SHA-256(canonical source path + NUL + exact bytes hash)，因此相同内容的不同物理sources仍独立退休。intent在retirement前durable记录snapshot hash、expected retired path、所有staged record payload/hash与publication progress；恢复器重新获取candidate locks并校验backup/retired file hash后幂等继续，completed receipt最后写入。

#### Precondition 与 dirty recovery
- 用户先关闭所有旧版 MCP clients并移除它们配置中的 caller-specific `PI_AGENT_MCP_STATE_DIR`。
- `cleanShutdown === true`: 可自动 preflight。
- `cleanShutdown === false`: 默认 `legacy_state_uncertain`，不会永远死锁；用户在确认旧 clients/Pi processes均已退出后，通过一次性 `PI_AGENT_MCP_IMPORT_DIRTY=1` opt-in attestation重试。active task转为 `host_interrupted`，原 `lastTask` 若存在则写入 conflict/backup artifact但 v2 API只暴露 interruption为 `lastTask`。
- dirty opt-in是人工确认，不声称软件能从 v1 metadata证明旧 writer不存在。

#### Source-atomic algorithm
1. 获取canonical root全局migration lock，再获取按source canonical path散列的source lock。
2. exact-byte snapshot、SHA-256、严格v1 schema/Pi header validation；no-replace写backup、全部staged payload与intent并fsync。由immutable snapshot推导本source全部candidate logical+actual-native lock keys。
3. 先按全局顺序获取所有candidate locks，再fresh-read全部v2 records并在持锁状态下执行完整inter-/intra-source preflight。logical ID或Pi header实际native ID任一冲突则写`conflicts.json`，释放locks；整个source保持原位且不发布records。preflight成功前绝不退休source。
4. clean或明确dirty attestation通过后，重新读取source并要求hash未变化；更新durable intent为`ready_to_retire`，包含expected retired path与全部publication payload/hash。
5. 在source目录将`sessions.json`原子rename为`sessions.v1.retired-<content-hash>.json`，永不删除；更新intent为`retired`。
6. 持有candidate locks，用atomic link no-replace逐个发布records并逐项更新intent progress。exact-existing record为幂等；different-existing理论上被locks+fresh preflight排除，若仍发生则fail closed并保留retired backup/intent供人工恢复。
7. 全部records durable后写completed receipt，再释放candidate locks。重跑不回滚已演进v2 record；`migrationId/sourceHash/sourceSessionHash`是record的immutable provenance，所有后续owned updates必须原样保留。
8. 任意启动优先扫描未完成intent：校验backup或retired file hash，重新获取candidate locks，fresh验证已发布项和未发布destination，按intent progress继续第6–7步。destination若exact staged payload则记为已发布；若immutable provenance、logical/actual-native identity和session path均与staged payload匹配且`revision >= staged revision`，则接受为已演进descendant、只推进intent而不覆盖；其他different-existing一律fail closed。因source已退休而不再可发现不影响恢复。

旧 caller-specific root中运行的 v2 Server检测到它正位于已知 legacy root时，不自动迁移且给出升级指导，避免两个独立 lock namespace各自吞入一部分数据。

### 错误与兼容
保留五工具输入 schema。新增/统一错误：
- `session_in_use`
- `native_session_in_use`
- `migration_blocked`
- `migration_conflict`
- `legacy_state_uncertain`
- `ownership_unavailable`

README新配置不再设置 state dir；升级章节给出顺序：停止 clients → 删除两边旧 env → 启动一个 v2 client → 检查 status/migration receipts → 再启动其他 client。

## 成功标准
- [ ] 两个 MCP Server共用一个 root，并行创建/运行不同 session，无 record丢失。
- [ ] 50进程竞争同 logical session时仅一个成功；不同 sessions可并行。
- [ ] 父 MCP `SIGKILL` 后旧 Pi仍活时第二 Server始终被锁；旧 Pi退出后才可获取。
- [ ] owner正常退出后另一 Server可恢复同一 native ID/path/history。
- [ ] corrupt/copied/hardlinked records从文件header导出同一actual-native lock，不能双启动。
- [ ] active task在安全接手时变 `host_interrupted`且不重放；generation/revision单调。
- [ ] `pi_close` remote contention与free dormant行为确定；status不抢锁。
- [ ] clean v1 sources从 default/Claude/Codex/explicit roots source-atomically、幂等迁移；旧文件保留。
- [ ] dirty source仅在显式 attestation后迁移；corrupt/变化中/冲突 source不退休。
- [ ] v1 closed、generation、name、cwd、model、Pi identity、lastTask按规则保留。
- [ ] 五工具单进程测试通过；双 Server/fake Pi多进程E2E覆盖正常接手、父 crash与alias。
- [ ] supported Node/platform matrix安装加载通过；README不再要求不同 state dir。

## 范围
- 包含: per-session store、kernel ownership与fd inheritance、content-derived native alias protection、动态status、v1 migration、README/config更新、多进程测试。
- 不包含: 在线强制移交、cross-server wait、task历史库、跨机器锁、Windows、daemon、网络API、第三方Pi writer保护。

## 实现期重点清单
- [ ] new-session crash injection覆盖prompt前ENOENT、file创建后recoverable publication前、invalid file；只有valid identity可reconcile为host_interrupted/recoverable。
- [ ] parent crash测试同时断言：child继承fds时竞争者blocked；cleanup在group exit前不调用`LOCK_UN`；child/group退出后才acquired。
- [ ] 所有恢复在Pi启动前取得logical+actual-native locks，actual native ID来自只读文件header，不再调用`switch_session`。
- [ ] `revision`、write queue、finalization、close顺序有确定性race tests。
- [ ] status overlay只在live ownership + matching revision时发生。
- [ ] migration source-atomic；candidate locks先于fresh preflight；source hash变化、concurrent migrator、retire后crash与未完成intent重启恢复可重试。
- [ ] 多进程测试只使用临时 roots/fake Pi，不读写用户真实 `~/.pi`。
- [ ] npm pack在supported clean environments中安装与加载ownership binding。

## 风险与明确取舍
- native/prebuilt dependency扩大供应链面；换取的是crash-safe kernel ownership。任何加载失败都fail closed。
- orphan Pi继承lock可保证不双写，但可能让session长期 `session_in_use`；v2不做自动杀孤儿或强制抢占。
- `flock`是协作式本地锁；不保护独立Pi TUI和恶意同UID进程，也不支持网络文件系统。
- idle Pi在其MCP Server存活期间持续持锁；v2不提供在线handoff。
- `pi_wait`仅为record的current/last task跨Server工作，不保留任意task历史；结果被下一task覆盖后返回`unknown_task`。
- dirty v1 import需要用户明确确认旧进程已停；这是v1缺少owner identity的不可消除限制。

## 可行性证据
- Pi 0.84.1 CLI支持 `--session-id` 与 `--session`；session manager在首次持久化时以 `openSync(..., "wx")` 创建新文件。
- `fs-ext-extra-prebuilt@2.2.12` tarball含Darwin/Linux x64/arm64、Node 20–25 prebuilds；本项目端到端支持线因Pi 0.84.1收窄为Node `>=22.19 <26`。MIT license，npm integrity可锁定。
- 2026-08-18本地PoC（Darwin arm64, Node 23.11.0）：parent和child继承同一locked fd时竞争者blocked；parent SIGKILL而child存活仍blocked；child SIGKILL后acquired。
