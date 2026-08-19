# Step 5 accepted finding fixes

Date: 2026-08-18
Status: DONE, pending independent reviewer verification
Scope: fixes for every accepted Step 5 Major/Minor finding in `step5-ownership-review.md` and `step5-migration-api-review.md`. No commit. Frozen spec/BRIEF/ROADMAP/archive files were not edited; the supervisor-owned PLAN change was already present and was not touched.

## Finding map

### 1. Exit/close race could resurrect closed — closed

Code:
- `src/session/session-manager.ts` adds a per-resident `lifecycleTail` queue.
- Exit handling runs in that queue and rechecks `closeRequested`/`cleanupIntent` after task finalization and after asynchronous identity validation.
- `#mutate` rejects any transition from durable `closed` back to a non-closed state.

Regression:
- `unexpected idle exit cannot resurrect a concurrently closed session` gates the idle exit's identity validation, starts close while the read is in flight, then proves the final and subsequent disk state remain `closed`.

### 2. failDispatch could release before concurrent close mutation — closed

Code:
- `#failDispatch`, exit handling, and close/shutdown cleanup share the lifecycle queue.
- Close publishes its monotonic intent before queueing cleanup.
- Dispatch failure may stop the process, but if close/cleanup intent exists it returns without publishing or releasing; queued cleanup exclusively owns task publication, final closed mutation, drain, and release.
- `#mutate` requires currently held ownership before and after the store operation.

Regression:
- `dispatch failure joins concurrent close and retains ownership through durable close` gates the shared stop and closed-record update, proves a contender remains fenced during publication, then proves acquisition is possible only after the closed commit and release.

### 3. Post-link/post-rename ambiguous success poisoned retries — closed

Code:
- `src/store/secure-fs.ts` wraps atomic write failures in `AtomicWriteError` with a `published` marker set only after this operation's link/rename succeeds.
- `SessionRecordStore.create/updateOwned` reconcile only a locally published final whose parsed full record exactly equals the intended record.
- Pre-publication/EEXIST errors never reconcile merely because another writer published identical bytes; divergent finals are never accepted.

Regressions:
- `SessionRecordStore reconciles exact post-link and post-rename ambiguous success` injects deterministic failures immediately after link/rename.
- `SessionRecordStore never accepts divergent finals after ambiguous publication` replaces the final with competing content and proves failure.
- `SessionRecordStore exact-existing create still conflicts without local publication` proves identical EEXIST is not misclassified as local success.

### 4. Explicit known legacy roots silently served isolated v2 — closed

Code:
- `resolveServerConfiguration` rejects explicit roots resolving to `~/.pi/agent-mcp-claude` or `~/.pi/agent-mcp-codex` before directory creation.
- Fatal startup guidance gives the ordered stop/remove-env/start-canonical/check-receipts/start-others recovery path.
- Arbitrary explicit roots remain supported isolation.

Regressions:
- `known caller-specific legacy roots reject explicit v2 startup with upgrade guidance` covers both known roots.
- `known caller-specific root startup diagnostics give ordered upgrade guidance` snapshots the actionable fatal message.

### 5. Identity-less error records could not close — closed

Code:
- `SessionOwnership` supports logical-only ownership for operations that cannot start Pi.
- Remote close uses logical-only ownership only when both `piSessionId` and `sessionFile` are absent.
- If either identity field exists, close requires both, parses the actual Pi header, and acquires the actual-native lock before fresh revision validation.

Regressions:
- `free error record without native identity closes under logical ownership`.
- `remote close preserves native fencing whenever identity exists` holds the actual native lock and proves close is blocked until release.

### 6. Corrupt final record blocked server startup / eager cache violated D10 — closed

Code:
- `SessionManager.initialize` no longer lists/caches disk records; memory maps are populated only for locally acquired/created residents and tasks.
- Dynamic `pi_status()` list still calls strict `SessionRecordStore.list()` and reports the corrupt final path.
- Single-session operations can access healthy records despite unrelated corruption.

Regression:
- `corrupt final record does not block startup or healthy session access` starts the production factory with one healthy and one corrupt final, reads the healthy status, and proves list status fails clearly.

### 7. Actual two-stdio-server process coverage absent — closed

Code/test:
- New `test/dual-stdio-shared.e2e.test.ts` launches two independent `node dist/src/index.js` processes against one temporary root and fake Pi.
- It covers parallel different-session spawn/no record loss, B status/wait/contention on A, graceful A EOF shutdown, B history-preserving takeover, wait, and close through MCP stdio JSON-RPC.

### 8. Remote wait repeatedly listed every record — closed

Code:
- `SessionRecordStore.findTaskRecords` performs one tolerant initial discovery for requested task IDs.
- `SessionManager` freezes each task ID to its discovered session ID, then every poll reads only that exact record.
- Mixed IDs retain independent target mappings.
- Exact target overwrite still produces `unknown_task`; current/last-only semantics are unchanged.
- Unrelated corrupt finals are ignored during discovery and never parsed during target polling.

Regression:
- `remote wait polls fixed target records and ignores unrelated corruption` covers two target sessions plus an unrelated corrupt final.
- Existing overwrite/pending/current-last tests remain green.

### 9. Final record mode/UID not enforced — closed

Code:
- `readSecureFile` accepts explicit `requireMode` and `requireCurrentUid` policies.
- V2 final record reads require mode `0600` and current UID.
- Legacy migration source reads retain their existing policy because callers do not request the v2-only restrictions.

Regression:
- `SessionRecordStore rejects non-0600 final records` proves `read` and `list` fail closed after chmod `0644`.
- UID enforcement is implemented through opened-fd metadata; wrong-UID creation is not portable in the current unprivileged test environment.

### 10. Impossible lifecycle combinations validated — closed

Code:
- Non-null active IDs must be non-empty and occur only in `creating`/`running`.
- `closed` cannot be recoverable or active.
- `creating` requires a preallocated native ID and active task and cannot be recoverable.
- `dormant`/`idle` must be recoverable, which already requires native ID and absolute session file.
- Optional identity/name/model fields cannot be empty.

Regression:
- `validateSessionRecord rejects impossible lifecycle combinations` covers closed/recoverable, closed/active, idle/active, creating without native/task, and nonrecoverable dormant states.

### 11. Exact five MCP input schemas not snapshotted — closed

Regression:
- `test/mcp-tools.integration.test.ts` now snapshots the complete normalized `listTools` schema for all five tools: object shapes, required fields, optional fields, `additionalProperties:false`, string/array minimums, enum values, defaults, and numeric bounds.

## Retirement filename compatibility

The frozen protocol's deterministic `sessions.v1.retired-<content-hash>.json` naming can be aligned safely without changing the existing durable intent/receipt schema:

- New migrations now store and use `sessions.v1.retired-<sourceHash>.json` in the existing `quarantinePath` field.
- Intent validation accepts both the new exact retired filename and the earlier `sessions.v1.quarantine-<migrationId>-<uuid>.json` form.
- Existing incomplete/completed intents and receipts retain their recorded paths and remain resumable/idempotent; there is no rewrite of durable transactions.
- `V1SessionMigrator resumes legacy UUID quarantine intents while new migrations use retired hashes` proves backward-compatible resume.
- README explains both the new name and old-intent compatibility.

## Validation

Final validation:

- pre/post `pgrep -fl 'dist/src/index\\.js|fake-pi\\.mjs|manager-host\\.mjs|ownership-child\\.mjs'`: no matching server/helper processes;
- `npm run typecheck`: PASS;
- `npm run build`: PASS;
- focused accepted-finding matrix (`session-record-store`, `session-manager`, `server-runtime`, dual stdio, MCP schemas, v1 migration): 80/80 PASS, 0 failed, ~4.77s;
- `npm test`: 104/104 PASS, 0 failed, ~5.20s;
- `npm pack --dry-run`: PASS, 59 files, 68.5 kB packed, 354.6 kB unpacked;
- `git diff --check`: PASS;
- staged files: none;
- frozen spec/BRIEF/ROADMAP/archive diffs: none. The supervisor-owned PLAN advancement was pre-existing and untouched.

No accepted Major remains open.

## Residual boundaries

Only frozen design/release boundaries remain: cross-platform clean-install matrix, advisory ownership status, current/last-only task history, cooperative local flock, and intentional orphan fail-closed behavior. Wrong-UID record behavior is implemented but cannot be generated deterministically without elevated privileges; mode enforcement is directly tested.

## Second re-review fix pass

Status: DONE, pending independent reviewer verification. This pass addresses all findings in `step5-ownership-rereview.md` and `step5-migration-api-rereview.md` without changing frozen design files.

### Ownership Major 1: late close intent at release — closed

- Intent-sensitive release now drains pending record writes before synchronously deciding whether close/shutdown cleanup owns the descriptors. There is no await between that final intent check and descriptor close.
- Exit and fail-dispatch use this release primitive; queued cleanup retains ownership and durably commits `closed` before release.
- Regressions gate close during fail-dispatch terminal publication, immediately before fail-dispatch release, and immediately before idle-exit release. Each proves a competing manager stays fenced until durable close.

### Ownership Major 2: remote wait versus same-manager close — closed

- Remote wait fresh validation, reconciliation mutation, and transient release now join the resident lifecycle queue.
- Reconciliation accepts an explicit expected task ID and requires the fresh owned record to match it before mutation.
- `remote wait reconciliation and same-manager close share lifecycle ownership` gates reconciliation while close is requested and proves serialized close plus continuous external fencing.

### Ownership Major 3: repeated reconciliation fsync failure — closed

- `SessionRecordStore` tracks the exact locally published successor when both the atomic writer's post-publication operation and reconciliation directory sync fail.
- Retry first verifies that exact final, establishes its directory durability, then either returns for an identical create/update or advances from the adopted revision. A divergent final is rejected.
- Manager mutation adopts the exact uncertain record in memory while retaining ownership, so cleanup retry does not use a stale revision.
- Regressions cover create retry, update-to-next-successor retry, divergent-final rejection, and manager cleanup after uncertain terminal publication.

### Migration/API Major: stale wait target mutation — closed

- Every remote reconciliation requires `activeTaskId` to equal the requested task before acquisition and again after fresh owned read.
- A local task map is authoritative only while its resident still owns the session; stale non-owned entries return to disk discovery.
- Regressions overwrite a task after discovery and replace a stale local task on disk, proving the successor is unchanged and the obsolete ID returns `unknown_task`.

### Migration/API Minors — closed

1. Ownership `initialize` and `acquire` normalize secure-path failures to path-free `ownership_unavailable` before any lock path can cross the public boundary; direct pre-acquire symlink regressions assert no absolute path.
2. `validateSessionRecord` rejects `running` with `activeTaskId:null`.
3. Mixed local/remote waits directly cover both `any` (remote complete/local pending) and `all` (both complete).
4. README now states that only identity-less error close is logical-only; either native identity field requires complete identity and native fencing.

No accepted Major or Minor remains open after this pass.

## Final ownership gate

Status: DONE, pending independent reviewer verification. This narrow pass closes the single Major in `step5-ownership-final-gate.md`.

### Descriptor shutdown remained locally undiscoverable — closed

- `ResidentSession` now exposes the in-flight ownership release as `releasePromise` while `SessionOwnership.close()` asynchronously closes native then logical descriptors.
- `SessionOwnership.held` remains false as soon as close starts, so authorization is never inferred while descriptor shutdown is underway.
- `#loadSession` joins the cached resident's release promise before rereading disk or replacing the resident. Same-manager close/send therefore cannot take a remote path while their own logical flock is still closing.
- Release completion clears the promise only after all descriptor-close work finishes; normal reload and remote acquisition then proceed from a fresh durable record.
- A narrow close hook permits deterministic tests to pause after native close and before logical close without changing production behavior.

Regressions:
- `same-manager close joins descriptor shutdown between native and logical release` starts idle-exit release, pauses between descriptor closes, proves close remains pending and an external contender remains fenced, then proves close reacquires and durably publishes `closed` without `session_in_use`.
- `send during descriptor shutdown waits for release and never mutates without ownership` pauses close release in the same interval, proves send remains pending, then proves it reloads the durable closed record and returns `session_closed` without changing task history.

No accepted final-gate Major remains open.

## Final release-ordering gate

Status: DONE, pending independent reviewer verification. This narrow pass closes the single ordering Major from reviewer `4e605e1f`.

### Pre-descriptor drain could bypass release join — closed

- `#loadSession` now checks and awaits an existing resident `releasePromise` before considering `ownership.held` or `process` authoritative.
- `pi_close` publishes monotonic close intent on a cached releasing resident before joining, so a pre-descriptor release is preserved for local cleanup instead of falling through to incomplete-identity remote close.
- After the release operation settles, load restarts from the current cache/disk state. A completed release therefore rereads the durable record before restore or close acquisition; a release preserved for queued cleanup can still select the locally owned resident only after the release decision finishes.
- `held` remains an authorization check only. The ordering change does not permit mutation while ownership is closing.

Regression:
- `send joins pre-descriptor drain release before restoring with new ownership` pauses `SessionRecordStore.drain()` while `releasePromise` exists and ownership still reports held, proves send remains pending and external acquisition remains fenced, then proves send restores through a new RPC under newly acquired ownership, completes, and the same manager closes the session durably.
- Existing drain-gated close and between-descriptor close/send tests remain green.

No accepted release-ordering Major remains open.
