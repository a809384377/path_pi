# Shared Session Registry v2 — Step 1 设计审查记录

日期: 2026-08-18

## 审查范围
- 主 spec: `ai/specs/2026-08-18-shared-session-registry-v2-design.md`
- 当前实现约束: `PiRpcProcess` detached process group、`SessionManager` task/finalization、v1 `JsonSessionStore`
- 上游约束: Pi 0.84.1 `--session-id`、`--session`、JSONL 创建/打开逻辑
- dependency: `fs-ext-extra-prebuilt@2.2.12`

## 初轮并行审查（完整问题清单）

### Blocker
1. parent-only flock不能fence orphan Pi：MCP被SIGKILL后detached Pi仍可能写，第二Server却已获得锁。
2. new session在知道/锁定native identity前启动Pi，存在先写后锁窗口。
3. established restore先`switch_session`再验证，损坏/alias record可在验证前写同一Pi文件。
4. migration若仍由旧caller-specific roots各自启动，会形成两个v2 destination与lock namespace，不能真正汇总。

### Major
1. lock pathname被替换可形成不同inode；需明确cooperative/private-root threat model并做lstat/fstat验证。
2. task `generation`不能兼任record revision；同generation的terminal/close写可能回滚，需要每mutation revision与write queue。
3. create-if-absent不能用覆盖型rename，需要temp fsync + hard-link no-replace。
4. bounded task history无法区分expired与unknown；不应为此建立全局task数据库。
5. 只poll record的remote wait不能在owner crash后自行发布host_interrupted。
6. cross-process `pi_close` ownership与free-running行为未定义。
7. dirty v1 source在旧进程崩溃后无法自动恢复clean bit，需要显式人工attestation路径。
8. migration conflict若部分激活会让source retirement不可恢复，需source-atomic policy。
9. migration ID只含content hash会让不同path相同内容冲突，必须含canonical source path。
10. native/prebuilt dependency与Node/platform support是发布gate，不能留到实现后决定。

### Minor
1. remote status只能在live local ownership + matching revision时overlay。
2. supported Node范围必须与Pi/runtime一致。
3. interrupted creating record、upgrade instructions和remote close需明确。

## 主会话修正
1. 通过gateway预生成Pi native UUID，new session用`--session-id`；restore直接用`--session`，不再调用write-capable `switch_session`。
2. logical与actual-native flock fd作为extra stdio传给Pi继承；父SIGKILL后旧Pi继续持锁，旧Pi退出后内核释放。
3. actual-native ID从Pi JSONL第一物理行严格解析，不信任record；hardlink/copy/corrupt alias收敛到同一native lock。
4. new session使用per-logical exclusive empty `--session-dir`，消除`--session-id`打开旧同ID文件的可能。
5. record加入每mutation `revision`、串行write queue、create hard-link no-replace。
6. v1 migration只向canonical root汇总；candidate locks先于fresh conflict preflight；整个source原子retire/activate；dirty import需要显式attestation。
7. durable migration intent先于retirement，启动优先恢复未完成intent；immutable provenance允许已发布且revision前进的descendant record原样接受，不覆盖。
8. `pi_wait`只跨进程支持record当前`activeTaskId`与`lastTask`，不建历史库或expiry index。
9. free-running remote close原子发布`host_interrupted + closed`，不启动Pi。
10. support收窄为macOS/Linux x64/arm64、Node `>=22.19 <26`，与Pi 0.84.1最低版本对齐。
11. new session先durable publish `recoverable:false`；文件首次创建后验证header才可recoverable/dormant。若中间crash，新owner在logical+native locks下reconcile有效文件，否则置nonrecoverable error。

## 最终审查
Reviewer `29a4d7e5`：PASS。

- Blocker: 0
- Major: 0
- Minor: 0
- 已验证：crash reconciliation在logical+native locks与exclusive-dir containment下工作；valid identity变`host_interrupted/dormant/recoverable:true`；invalid/absent变`error/recoverable:false`且不启动Pi；task `lastTask` publication与session recoverability分离。

## 可行性证据
- Pi 0.84.1支持`--session-id`和`--session-dir`；仅`get_state`返回预分配ID与intended path，不创建JSONL。
- Pi session首次持久化使用`openSync(..., "wx")`。
- dependency tarball包含Darwin/Linux x64/arm64、Node 20–25 prebuilds；项目端到端支持取交集Node 22.19–25。
- 本地Darwin arm64 / Node 23.11.0 PoC：
  - parent + inherited-fd child：竞争者blocked；
  - parent SIGKILL、child存活：仍blocked；
  - child SIGKILL：竞争者acquired。

## 剩余风险（明确接受边界）
1. orphan Pi可无限持锁，需要用户人工终止process group；这是fail-closed而非自动偷锁。
2. 不保护不遵守协议的独立Pi/TUI writer。
3. 不抵御恶意同UID进程替换私有root路径。
4. 不支持NFS/SMB、跨机器和Windows。
5. idle Pi在MCP Server存活期间保持ownership，v2无在线handoff。
