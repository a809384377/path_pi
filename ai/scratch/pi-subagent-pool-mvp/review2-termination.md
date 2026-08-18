## Review

### Blocker

1. **`Promise.all` rejects before all session cleanups finish, and signal shutdown can orphan untouched detached process groups.**
   - **Evidence:** `SessionManager.#runShutdown()` awaits `Promise.all(...)`, which rejects as soon as one `#cleanupSession()` rejects, without awaiting the remaining cleanup promises (`src/session/session-manager.ts:283`). The signal error path immediately calls `process.exit(1)` (`src/server.ts:118`). Pi children are detached process-group leaders (`src/rpc/pi-rpc-process.ts:99`).
   - **Reproduction:** Create two resident sessions. Make session A’s `rpc.stop()` reject immediately and session B’s `stop()` remain pending. Call `shutdown()` from the SIGTERM path. A rejects, `Promise.all` rejects while B still owns its process, and `process.exit(1)` terminates the MCP host before B’s TERM→KILL cleanup completes. B’s detached Pi/process group survives.
   - **Required correction:** Start every cleanup concurrently, await `Promise.allSettled`, and only then reject shutdown with an aggregate failure. Never exit the host while any owned cleanup remains pending.

### Major

1. **An in-flight finalization can overwrite `closing` with `idle`, allowing `pi_send` to create a task that close subsequently discards.**
   - **Evidence:** Cleanup first sets `closing` and then awaits an existing `finalizationPromise` (`src/session/session-manager.ts:533`). Successful publication unconditionally replaces the session state with the task’s earlier `nextState`, commonly `idle`, and clears `activeTaskId` (`src/session/session-manager.ts:469`). `send()` accepts that `idle` state (`src/session/session-manager.ts:185`). Cleanup later unconditionally clears whatever active task now exists and closes the session (`src/session/session-manager.ts:571`).
   - **Reproduction:** Gate the terminal save for task A after `agent_settled`; call `close()` while that save is blocked; attach a task-A waiter that calls `send()` when publication occurs; release the save. Publication sets the session to `idle` and emits `taskTerminal` before the awaited finalization continuation resumes, so the waiter reserves task B. Cleanup then resumes, stops the RPC, clears task B’s ownership, and marks the session closed. Task B may have returned `status:"running"` but can never reach a terminal result.
   - **Required correction:** Publication must preserve `closing/closed` lifecycle ownership instead of applying stale `nextState`; cleanup must also verify that the active task/session generation has not changed before clearing ownership.

2. **TERM→KILL confirms only the Pi leader; a TERM-resistant tool descendant survives clean shutdown.**
   - **Evidence:** After group SIGTERM, termination returns immediately when the Pi child’s exit promise resolves, skipping group SIGKILL (`src/rpc/pi-rpc-process.ts:256`). The child reference and PID are cleared on leader exit (`src/rpc/pi-rpc-process.ts:269`), so the surviving process group can no longer be targeted. The existing process-tree test uses a tool child with default SIGTERM behavior and does not exercise this case (`test/session-manager.integration.test.ts:476`).
   - **Reproduction:** Have Pi spawn a tool child that installs a SIGTERM handler and remains alive. Call `close()` or `shutdown()`. Group SIGTERM exits the Pi leader while the tool child ignores it; leader exit resolves `exitPromise`, `stop()` succeeds without SIGKILL, and the manifest can become clean while `process.kill(toolChildPid, 0)` still succeeds.
   - **Required correction:** Retain the process-group ID independently of the leader object and confirm group disappearance, not merely leader exit; send SIGKILL to the retained group after the grace period whenever any group member remains.

### Minor

- None.

### Original Lifecycle Findings

1. **stdin EOF shutdown — fixed.** Explicit stdin `end`/`close` and transport-close handlers share an idempotent shutdown promise (`src/server.ts:109`); an end-to-end EOF test covers server, Pi, tool child, and clean manifest termination (`test/stdio-shutdown.e2e.test.ts:26`).
2. **Protocol failure/stop dropping Pi leader ownership — fixed.** Ownership is cleared only by confirmed `exit/close`, and unconfirmed SIGKILL causes `stop()` to reject (`src/rpc/pi-rpc-process.ts:256`, `src/rpc/pi-rpc-process.ts:269`). The descendant-process defect above is a separate residual process-tree issue.
3. **Spawn crossing completed shutdown — fixed.** `spawn()` rechecks availability immediately after asynchronous cwd validation (`src/session/session-manager.ts:136`).
4. **Concurrent close/shutdown reopening a closed session — fixed.** Cleanup is coalesced through `cleanupPromise`, while `closeRequested` determines the final closed state (`src/session/session-manager.ts:525`, `src/session/session-manager.ts:571`). The finalization/close race above is distinct.
5. **Terminal publication before durable persistence — fixed.** Waiters require `published`, publication occurs only after persistence succeeds, and finalizing sessions reject send (`src/session/session-manager.ts:221`, `src/session/session-manager.ts:458`).
6. **Settled before prompt acceptance — fixed.** Early settled is retained as `pendingSettled`; completion starts only after prompt success, while prompt failure clears it (`src/session/session-manager.ts:322`, `src/session/session-manager.ts:365`).
7. **Abort timeout and serial all-session shutdown — fixed for the original causes.** Abort uses shutdown grace, stop starts concurrently, and per-session cleanups start in parallel (`src/session/session-manager.ts:285`, `src/session/session-manager.ts:558`). Blocker 1 is the new early-rejection failure mode.
8. **Malformed response treated as an event — fixed.** `type:"response"` is strictly validated and malformed shapes immediately trigger protocol failure (`src/rpc/pi-rpc-process.ts:196`).
9. **Unsupported Windows process-tree cleanup — fixed by scope restriction.** Package metadata limits supported OSes, and README explicitly declares Windows unsupported (`package.json:23`, `README.md:9`).
