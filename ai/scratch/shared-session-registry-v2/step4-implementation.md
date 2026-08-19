# Step 4 implementation handoff

Date: 2026-08-18
Status: DONE, pending Step 5 independent adversarial review
Scope: explicit server factory and canonical migration startup, dynamic shared-registry status/current-last wait, five-tool compatibility/error redaction, README/configuration, and black-box independent-runtime tests. No commit and no frozen PLAN/spec/BRIEF/ROADMAP/archive edits.

## Runtime and factory wiring

- `src/server.ts` now resolves the default state root to `~/.pi/agent-mcp` for every caller through `canonicalDefaultStateRoot`.
- An explicitly supplied `PI_AGENT_MCP_STATE_DIR` remains an isolated advanced/test registry and disables all automatic legacy consolidation, even if it names the canonical path.
- Factory startup creates and validates the root plus `sessions`, `pi-sessions`, `locks`, `migrations`, and `tmp` as private `0700` directories.
- The factory explicitly constructs `SessionRecordStore`, `OwnershipLockManager`, `FlockMigrationCandidateLockCoordinator`, `V1SessionMigrator`, and `SessionManager` against the same root.
- Canonical startup runs `resumeIncomplete()` first, then processes discovered canonical/Claude/Codex/`PI_AGENT_MCP_LEGACY_STATE_DIRS` sources in order before registering tools.
- `PI_AGENT_MCP_IMPORT_DIRTY=1` is passed only as migration dirty attestation. Dirty startup otherwise fails with actionable `legacy_state_uncertain`; source conflicts fail with `migration_conflict` while leaving the source live.
- `src/index.ts` sanitizes fatal ownership/migration startup diagnostics while retaining support-matrix and recovery instructions.

## Dynamic shared-registry behavior

- `SessionManager.status` is asynchronous and reads final records from disk on every call.
- List status filters closed records dynamically and fails clearly for any corrupt final record; it does not return a partial list.
- Local runtime overlay occurs only while this manager still holds ownership and its cached record revision equals the disk revision.
- Remote/free records report `resident: "unknown"`; `ownership` is `local | other | free_or_unknown` and is explicitly diagnostic-only.
- Ownership observation reads the stable lock diagnostic without attempting `flock`, starting Pi, or authorizing any mutation. Release markers are best-effort diagnostics only.
- `pi_wait` remains event-driven when all exact task IDs are locally owned.
- Remote/mixed waits dynamically find only exact durable `activeTaskId`/`lastTask.taskId` slots, poll in bounded 25ms intervals, return truthful pending/terminal subsets, and keep timeout non-cancelling.
- A free current active task is reconciled under full logical/native ownership without launching Pi. Established active tasks become `host_interrupted/dormant`; incomplete creating/nonrecoverable records use the Step 3 reconciliation rules.
- Contended/orphan-owned remote tasks remain pending. Once a newer task overwrites the last slot, the older remote ID returns `unknown_task`; no task history was added.
- `SessionRecordStore.read/list` now retries only transient `unsafe_file_identity`/`ENOENT` observations caused by another writer's atomic rename, then still fails closed for persistent corruption or identity errors.

## Five-tool API and errors

- Exactly five registered tool names remain: `pi_spawn`, `pi_send`, `pi_wait`, `pi_status`, `pi_close`.
- All input schemas are unchanged.
- Tool ownership/migration errors are reduced to stable public codes without lock paths, native IDs, source paths, or diagnostic content: `session_in_use`, `native_session_in_use`, `migration_blocked`, `migration_conflict`, `legacy_state_uncertain`, `ownership_unavailable`.
- Existing non-sensitive validation/lifecycle errors remain compatible.
- Remote `pi_send` and `pi_close` continue to perform disk lookup and full ownership acquisition; contention returns the public in-use code.

## Documentation

- `README.md` now configures Claude Code and Codex against the same default registry without caller-specific state roots.
- It documents explicit isolation, the stop/remove-env/start-one/check-receipts/start-others upgrade order, legacy source lists, dirty attestation, orphan recovery, supported OS/CPU/Node/Pi boundary, shared registry layout/modes, and the ownership support matrix.
- All five tools, public errors, dynamic status/current-last wait behavior, no history, and idle resident ownership/no online handoff are documented.

## Tests added or updated

- New `test/server-runtime.integration.test.ts` uses independent production factory runtimes, real kernel locks, temporary roots, and fake Pi only. It covers:
  - canonical and explicit-root configuration;
  - secure directory creation;
  - clean startup migration and receipts;
  - explicit-root non-consolidation;
  - dirty attestation;
  - migration conflict startup failure;
  - two independent runtimes concurrently spawning different sessions without record loss;
  - dynamic cross-runtime status and ownership diagnostics;
  - observational status and corrupt final record failure;
  - remote pending/current/last wait, free reconciliation, and overwritten-ID behavior;
  - same-session contention;
  - graceful takeover preserving native history;
  - free remote close without Pi startup.
- `test/mcp-tools.integration.test.ts` now uses the v2 record store and proves exactly five tools plus redacted `session_in_use` at the MCP response boundary.
- `test/session-manager.integration.test.ts` was updated for asynchronous dynamic status and explicit remote `resident/ownership` semantics.

## Exact validation

- Pre-validation leak check: `pgrep -fl 'fake-pi\\.mjs|manager-host\\.mjs|ownership-child\\.mjs'` returned no matches.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `node --test --test-timeout=15000 dist/test/server-runtime.integration.test.js dist/test/session-manager.integration.test.js dist/test/mcp-tools.integration.test.js dist/test/stdio-shutdown.e2e.test.js`: PASS, 32/32, 0 failed, duration ~3.00s.
- `npm test`: PASS, 89/89, 0 failed, duration ~4.37s.
- `npm pack --dry-run`: PASS, 59 files, package size 65.9 kB, unpacked size 338.5 kB.
- `git diff --check`: PASS.
- Post-validation leak check: no matching fake Pi/manager-host/ownership-child processes.
- Installed Pi probe: `/opt/homebrew/bin/pi` version `0.84.1`; isolated temporary `HOME` and session directory; `pi --session-dir <temp> --session-id 11111111-1111-4111-8111-111111111111 --mode rpc` accepted a no-prompt `get_state`, returned the exact session ID and an intended file inside the isolated directory, then terminated with no leaked PID.
- Git index: no staged files.
- Frozen artifacts: no diffs under spec, PLAN, BRIEF, ROADMAP, or archive.

## Changed files

- `README.md`
- `src/index.ts`
- `src/ownership/session-ownership.ts`
- `src/server.ts`
- `src/session/session-manager.ts`
- `src/store/session-store.ts`
- `test/mcp-tools.integration.test.ts`
- `test/server-runtime.integration.test.ts`
- `test/session-manager.integration.test.ts`
- `ai/scratch/shared-session-registry-v2/step4-implementation.md`

## Residual risks and Step 5 review targets

- Full clean-install/load validation for every declared macOS/Linux x64/arm64 and Node 22-25 combination remains release/CI work; this run validated Darwin arm64, Node 23.11.0, and installed Pi 0.84.1.
- Ownership status is deliberately instantaneous, advisory, and may degrade to `free_or_unknown`; authorization always requires kernel lock acquisition. PID reuse cannot authorize work.
- Remote wait polling is intentionally limited to current/last durable slots and may return `unknown_task` after overwrite by design.
- Atomic-final-record rereads use five bounded 1ms retries. A writer continuously replacing the same final record can still surface an identity error rather than returning stale data, which is fail-closed.
- Orphan Pi descendants may hold inherited ownership indefinitely until manually terminated, per the frozen design.
- Network filesystems, Windows, hostile same-UID mutation, independent Pi TUI/third-party writers, and online idle-session handoff remain outside scope.
- Step 5 should independently attack status advisory accuracy, wait/revision races, migration startup ordering/contention, error redaction, and remote close/takeover races. No Step 5 review has been started here.

---

## Step 5 accepted-finding remediation

Date: 2026-08-18
Status: DONE, pending independent verification

All accepted findings from `step5-ownership-review.md` and `step5-migration-api-review.md` were fixed with deterministic regressions. Full mapping and rationale: `ai/scratch/shared-session-registry-v2/step5-fixes.md`.

Highlights:
- lifecycle callbacks/cleanup are serialized; closed state is monotonic and mutation requires live ownership;
- exact post-link/post-rename ambiguous success is reconciled only when this operation published the exact intended final;
- known caller-specific legacy roots fail startup with ordered upgrade guidance;
- identity-less free error records close under logical-only ownership, while any native identity/path preserves actual-native fencing;
- startup no longer enumerates/caches records; corrupt finals do not block healthy single-session operations but list status still fails clearly;
- remote waits discover targets once and poll only exact session records;
- v2 final records enforce `0600` and current UID and reject impossible lifecycle combinations;
- exact five-tool input schemas are snapshotted;
- two independent production stdio hosts now cover shared-root operation and graceful takeover;
- new migration retirement names follow `sessions.v1.retired-<content-hash>.json`, while existing UUID-quarantine intents remain accepted/resumable.

Final validation counts are recorded in the acceptance report for this remediation run. The supervisor-owned PLAN advancement was pre-existing and was not edited by this writer.

Final Step 5 fix validation:
- typecheck/build: PASS;
- focused accepted-finding matrix: 80/80 PASS;
- full suite: 104/104 PASS;
- pack dry-run: 59 files, 68.5 kB packed, 354.6 kB unpacked;
- diff check: PASS;
- pre/post server/helper leak scans: no matches;
- no staged files;
- no writer changes to frozen spec/BRIEF/ROADMAP/archive; supervisor-owned PLAN advancement was pre-existing and untouched.
