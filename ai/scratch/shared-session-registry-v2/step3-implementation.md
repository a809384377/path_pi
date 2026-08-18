# Step 3 implementation handoff

Date: 2026-08-18
Status: DONE, pending independent adversarial review
Scope: production kernel ownership, migration lock coordinator, inherited Pi descriptors, and SessionManager v2 ownership lifecycle. No PLAN/README/schema/server-config/ROADMAP/archive edits and no commit.

## Dependency and supported runtime

- Added exact runtime dependency `fs-ext-extra-prebuilt@2.2.12`.
- `package-lock.json` pins integrity `sha512-2i9bq9kZGv8IZqRDYL4rsItRN6NmH/8fs6NZ4hL+vU+rnp9j2/Cc8myRCrB0xnn4kqmfzeYaNR9oE0bnSvuUng==`.
- `package.json` and lockfile root engines are `>=22.19 <26`.
- `src/ownership/flock.ts` is the local typed lazy-load boundary. Binding/load/unsupported errors become `ownership_unavailable` with platform/arch/Node diagnostics. There is no userspace lease/PID fallback.

## Production ownership module

Files:
- `src/ownership/flock.ts`
- `src/ownership/session-ownership.ts`
- `src/ownership/index.ts`

Public API:
- `OwnershipLockManager(root)`
  - `initialize()`
  - `lockPath(domain, key)`
  - `acquire(domain, key, diagnostic?)`
  - `acquireSession(logicalId, nativeId, diagnostic?)`
- `OwnershipLockHandle`
  - `fd` / `inheritedFd`
  - `held`
  - `close()` (close-only release; never explicit `LOCK_UN`)
- `SessionOwnership`
  - `logical`, `native`
  - `inheritedFds` as logical/native tuple
  - `held`
  - `close()` in native/logical reverse order
- `FlockMigrationCandidateLockCoordinator`
- `deduplicateAndOrderCandidates(candidates)`

Invariants implemented:
- Stable permanent files under private `locks/`; files are never unlinked on release.
- Domain-separated SHA-256 names for `migration`, `source`, `logical`, and `native`.
- Component-wise no-symlink checks inherited from Step 2 secure-fs.
- Open uses `O_RDWR | O_CREAT | O_NOFOLLOW`; path/opened identity must match and be a regular current-UID mode-0600 file.
- Locks directory is fsynced, including after lock-file open/create.
- Exclusive nonblocking `flock("exnb")` only.
- `EAGAIN`/`EWOULDBLOCK` logical contention maps to `session_in_use`; native contention maps to `native_session_in_use`; migration/source contention maps to `migration_blocked`.
- A bounded <=4096-byte JSON diagnostic is truncated/written/fsynced only after acquisition. Diagnostics are never used to infer staleness or authorization.
- FileHandle is retained strongly for the handle lifetime.
- Any acquisition/validation/diagnostic error closes the opened descriptor safely.
- Runtime acquisition is logical then actual-native; failure closes the logical handle.
- Migration candidates are treated as an ordered set: deduplicate kind+key, then migration -> source -> sorted logical -> sorted native; release is reverse.

## PiRpcProcess seam

New public types/options:
- `PiStartup`
  - `{ kind: "new", sessionDirectory, sessionId }`
  - `{ kind: "restore", sessionFile }`
  - `{ kind: "default" }` retained only for compatibility callers/tests
- `PiRpcProcessOptions.startup`
- `PiRpcProcessOptions.ownershipFds`

Exact argv:
- new: `--session-dir <exclusive> --session-id <native> --mode rpc [--model ...]`
- restore: `--session <absolute-jsonl> --mode rpc [--model ...]`

The spawned stdio array is exactly `pipe, pipe, pipe, ...ownershipFds`, so Node duplicates the locked open-file descriptions into extra Pi descriptors. PiRpcProcess does not close or release the parent ownership handles; SessionManager owns them. Existing detached process-group TERM/KILL/confirmed-exit logic remains. Manager release is guarded by `rpc.processOwned === false`.

## SessionManager v2 lifecycle

`SessionManager` now persists through `SessionRecordStore` and owns `OwnershipLockManager` handles. It accepts an explicit v2 store/lock manager. The old `LegacyJsonSessionStore` constructor option is retained only as a Step 4 compatibility seam: its path dirname is used to construct a v2 `SessionRecordStore`; no v1 manifest writes occur.

Public Step 4 seams:
- `manager.recordStore`
- `manager.ownershipManager`
- `SessionManagerOptions.store: SessionRecordStore | LegacyJsonSessionStore`
- `SessionManagerOptions.ownership?: OwnershipLockManager`
- `SessionManagerOptions.nativeIdFactory?`
- existing five-operation manager API remains: `spawn`, `send`, `wait`, `status`, `close`, `shutdown`.

### New session

1. Validate cwd/task and allocate gateway, Pi-native, and task IDs.
2. Acquire logical then preallocated native ownership.
3. Create/validate private empty `pi-sessions/<logical-hash>/`.
4. Atomic-create revision-1 `creating`, `recoverable:false`, active-task record.
5. Start Pi with explicit new argv and both inherited fds.
6. Validate get_state native ID, absolute direct-child path containment, and ENOENT before prompt.
7. Durable revision bind to `running/recoverable:false/sessionFile`.
8. Only then send prompt.
9. Terminal task outcome is always durably written. The file header is strictly validated before `recoverable:true`; invalid/missing header publishes lastTask but leaves `error/recoverable:false`.

### Established restore/send

1. Read record, then acquire logical lock.
2. Strictly open/parse the actual Pi JSONL first header; require record/native agreement.
3. Acquire actual-native lock from header ID.
4. Fresh-read revision/path and recheck device/inode/header identity.
5. Start directly with `--session`; never call `switch_session`.
6. Validate get_state ID/path.
7. A free stale `running/activeTaskId` record is durably changed to `host_interrupted` under full ownership without prompt replay.
8. Publish the next generation/running task durably, then prompt.
9. Resident idle/error-recoverable sessions retain both locks and reuse the live Pi process.

### Crash reconciliation

For `creating` or `running/recoverable:false`:
- Acquire logical and record-preallocated native locks.
- Fresh-read revision/native identity.
- Require intended path to be directly inside derived private `pi-sessions/<logical-hash>/` and validate the directory and strict header.
- Valid identity publishes `host_interrupted` when needed, clears active task, and becomes `dormant/recoverable:true`; normal direct restore then proceeds.
- Missing, invalid, out-of-directory, symlink, nonregular, or mismatched file becomes `error/recoverable:false`, with no Pi start.

### Close/shutdown/release

- Local close/shutdown marks lifecycle closing, waits any in-flight terminal finalization, aborts/stops and confirms the complete Pi process group, durably publishes closed/dormant plus terminal interruption, drains the record queue, and only then closes parent native/logical descriptors.
- Persistence failure retains ownership until later cleanup succeeds.
- Unconfirmed group exit retains ownership and makes shutdown fail. A later confirmed exit retries cleanup and then releases.
- Unexpected confirmed process exit publishes failure/dormant/error first; persistence failure retains parent locks.
- Remote occupied send/close gets `session_in_use` (or native alias gets `native_session_in_use`).
- Free remote running close writes `host_interrupted + closed` without starting Pi.
- Status is observational and does not acquire ownership.

## Test coverage added/updated

### Ownership multiprocess
- 50 synchronized processes on one logical key: exactly 1 acquisition, 49 `session_in_use`.
- Different keys acquire independently.
- Lock inode remains unchanged across close/reacquire; lock mode is 0600 and diagnostics are present.
- Unsafe mode/symlink lock files are rejected without replacement/unlink.
- Parent `SIGKILL` while a child inherits the locked open-file description remains blocked; child exit permits acquisition.
- Migration candidate order/dedup and real kernel contention/reacquisition.

### PiRpcProcess
- Exact new and restore args.
- Exact inherited numeric stdio entries.
- `get_state` is the first command; no prompt precedes manager ownership/bind.
- Prior response correlation, malformed transport, EPIPE, TERM/KILL and unconfirmed-exit tests remain.

### SessionManager
- Three concurrent v2 sessions.
- New startup/fd ownership and nonrecoverable bind before prompt.
- Direct restore/no switch.
- Second-manager contention and graceful takeover preserving conversation context.
- Actual-native alias fencing.
- Free established-running stale interruption.
- Valid/invalid recoverable:false reconciliation.
- Terminal lastTask durability with invalid Pi header.
- Free remote running close without Pi start.
- Delayed-start close race and settled-before-rejected-prompt race.
- Terminal persistence failure retains locks until durable cleanup.
- Real manager-host `SIGKILL`: fake Pi inherited fds continue fencing until its process group exits.
- Unconfirmed group exit retains locks; late confirmation releases after cleanup.
- Status does not acquire locks.
- stdio EOF test now verifies the final v2 record and complete Pi/tool-child group cleanup.

All test fixtures use temporary roots. Final pre/post test process checks found no `fake-pi.mjs`, `manager-host.mjs`, or `ownership-child.mjs` processes.

## Exact validation

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `node --test --test-timeout=15000 dist/test/session-ownership.test.js dist/test/pi-rpc-process.test.js dist/test/session-manager.integration.test.js`: 34/34 PASS, 0 failed, duration ~2.72s.
- `npm test`: 80/80 PASS, 0 failed, duration ~3.86s.
- `git diff --check`: PASS.
- `npm pack --dry-run`: PASS; 59 files, package size ~60.2 kB, ownership JS/d.ts included.
- `pgrep -fl 'fake-pi\\.mjs|manager-host\\.mjs|ownership-child\\.mjs'` before/after focused and after full validation: no matches.
- No staged files.
- No PLAN diff.

## Deliberate Step 4 boundaries / residual risks

- `src/server.ts` remains unchanged per boundary. It still constructs the legacy-named store; SessionManager internally maps that path to v2. Step 4 should wire `SessionRecordStore`, `OwnershipLockManager`, production migration coordinator, and migration discovery explicitly.
- Dynamic cross-server disk refresh for status and remote current/last `pi_wait` polling remain Step 4. Current status is observational but reflects initialized/local cache rather than every later remote mutation.
- Automatic production migration invocation is not wired into server startup yet; `FlockMigrationCandidateLockCoordinator` is ready for Step 4.
- Validation was on the current Darwin arm64/Node 23 environment. Pack includes the exact dependency declaration, but clean install/load across every declared macOS/Linux x64/arm64 and Node 22–25 combination remains final CI/release work.
- Real Pi 0.84.1 was not exercised in this test pass; fake Pi validates argv/state/file/lifecycle contracts. Actual Pi compatibility remains a final integration check.
- flock remains local/cooperative only: no NFS/SMB/Windows or hostile same-UID defense.
- An orphan Pi may intentionally hold ownership indefinitely until manually terminated.

Independent adversarial Step 3 review is still required before acceptance.

---

## Post-review remediation (ae7646fe)

The first independent Step 3 review found one Blocker, three Major findings, and one Minor finding. All were accepted and remediated:

- Admission tokens now fence `spawn`, `send`, and `close`; shutdown closes entry, waits admitted operations, then snapshots cleanup. Shutdown failure is retryable while new work remains permanently forbidden.
- Restore retains verified Pi path/device/inode identity and rechecks immediately pre-launch and post-start. Same-header inode replacement is rejected before prompt and the started Pi is stopped.
- Terminal publication is exact-result retryable. Known completed/failed/aborted results cannot be downgraded to interruption after transient persistence failure.
- Finalization promises are installed before awaited settle work. Cleanup drains finalization both before and after abort/stop, serializes revisions, clears failed attempt promises, and supports safe shutdown retry while retaining locks on genuine unconfirmed group exit.
- Package CPU metadata and ownership load diagnostics now state the frozen support matrix.

Updated final validation:
- bounded focused tests: 34/34 pass
- full suite: 80/80 pass
- pack dry-run: 59 files, approximately 60.2 kB
- no matching test helper processes remain

Review verbatim and disposition: `ai/scratch/shared-session-registry-v2/step3-review.md`.
