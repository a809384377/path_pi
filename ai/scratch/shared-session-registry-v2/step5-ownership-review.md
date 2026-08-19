## Review

**Verdict: FAIL — 0 Blockers, 3 Majors, 0 Minors.**

- Correct: Status overlays local runtime only while ownership is held and revisions match (`src/session/session-manager.ts:974`).
- Correct: Restore and remote close derive native ownership from the opened Pi header rather than record metadata (`src/session/session-manager.ts:393`, `src/session/session-manager.ts:462`).
- Correct: Remote wait fresh-reads after reconciliation and preserves current/last-only semantics (`src/session/session-manager.ts:914`).
- Correct: Ownership release rejects live process groups and closes descriptors without `LOCK_UN`, preserving orphan Pi fencing (`src/session/session-manager.ts:805`, `src/ownership/session-ownership.ts:53`).

### Major 1 — Exit/close race resurrects a closed session

- **Phenomenon:** `#handleExit` checks cleanup/closed state only before an asynchronous identity read. After that read it constructs a new mutation from the current mutable `session.record`, so a concurrent close can commit `closed` and then be overwritten by `dormant` or `error`.
- **Schedule:** (1) An idle resident at revision R exits unexpectedly; `#handleExit` clears `session.process`, passes the cleanup check at `src/session/session-manager.ts:680`, and pauses in `#recordIdentityValid` at `src/session/session-manager.ts:694`. (2) Concurrent `pi_close` sees held ownership at `src/session/session-manager.ts:339`, runs cleanup, commits `closed` at `src/session/session-manager.ts:785`, and releases ownership. (3) The exit handler resumes and spreads the now-closed `session.record`, then commits revision R+2 as `dormant`/`error` at `src/session/session-manager.ts:696`.
- **Impact:** A successful permanent close can be immediately undone. The supposedly closed session becomes sendable/restorable again, violating the five-tool close contract and durable lifecycle monotonicity.
- **Missing test:** Existing close/startup coverage begins at `test/session-manager.integration.test.ts:544`; there is no idle-process-exit versus close schedule.

### Major 2 — Dispatch failure releases ownership while close still mutates

- **Phenomenon:** `#failDispatch` independently releases ownership without joining an already-running cleanup. Close and dispatch failure can both await the same process termination, after which dispatch failure releases the locks before cleanup publishes its terminal and closed records.
- **Schedule:** (1) A prompt/start failure enters `#failDispatch`, captures the RPC, and awaits `rpc.stop()` at `src/session/session-manager.ts:715`. (2) Concurrent `pi_close` sets `closeRequested` and starts cleanup, which also waits on `rpc.stop()` at `src/session/session-manager.ts:756`. (3) Process termination resolves the dispatch continuation first; because close set `closeRequested`, dispatch skips terminal publication at `src/session/session-manager.ts:723` and releases ownership at `src/session/session-manager.ts:727`. (4) Cleanup resumes and publishes the task/closed state at `src/session/session-manager.ts:781` and `src/session/session-manager.ts:785` despite no longer owning either lock. (5) A third host can acquire ownership between steps 3–4 and restore or mutate the same record.
- **Impact:** The old host performs `updateOwned` after ownership transfer. Because revision checking is not itself a cross-process lock, the cleanup and new owner can both read the same revision and rename competing successors; the old cleanup may close or overwrite a session already running under the new owner.
- **Missing test:** The delayed-start close test at `test/session-manager.integration.test.ts:544` does not force `#failDispatch` and `#runCleanup` to resume from the same stop promise in the adverse order.

### Major 3 — Post-rename errors make durable mutation retries permanently conflict

- **Phenomenon:** Atomic replacement can change the final record and then reject if directory sync fails. `#mutate` advances its in-memory record only after the store promise resolves, with no ambiguous-success reconciliation.
- **Schedule:** (1) Terminal publication calls `updateOwned` for revision R→R+1. (2) `replaceAtomic` successfully renames the new record at `src/store/secure-fs.ts:147`, making R+1 visible, but `syncDirectory` at `src/store/secure-fs.ts:148` returns `EIO`. (3) The store propagates failure from `src/store/session-store.ts:139`; `#mutate` therefore leaves memory at R because assignment occurs only at `src/session/session-manager.ts:815`. (4) Finalization reports a persistence error. (5) Shutdown retries from expected revision R, reads visible R+1, and receives `revision_conflict` forever, retaining ownership and preventing clean shutdown.
- **Impact:** A transient post-commit durability error poisons all in-process retries even though the intended successor is already present. Terminal publication/shutdown can remain permanently failed and ownership remains unnecessarily fenced. The same ambiguity after create’s successful hard-link at `src/store/secure-fs.ts:125` can leave an unreturned `creating` record after spawn closes ownership at `src/session/session-manager.ts:219`.
- **Missing test:** `FailingRecordStore` injects failure before calling the real update (`test/session-manager.integration.test.ts:101`), so retry tests such as `test/session-manager.integration.test.ts:626` do not exercise post-rename/post-link ambiguous success.

## Residual Risks

- Frozen threat-model residuals, not defects: malicious same-UID replacement, independent Pi/TUI writers, network filesystems, Windows, and permanently surviving orphan Pi processes requiring manual termination.
- Frozen API tradeoff, not a defect: remote waits forget a task after a later task overwrites the record’s last-task slot.
- Step 6 validation, not a defect: supported Node/platform clean-install matrix, package loading, and real Pi 0.84.1 end-to-end validation remain pending.
- Physical power-loss guarantees remain outside this review; Major 3 concerns an observable runtime error after a successful namespace mutation, not speculative crash persistence.