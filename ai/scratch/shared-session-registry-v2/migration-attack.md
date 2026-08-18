## Review

- **Correct:** The Sprint identifies per-session records, ownership, stale recovery, and idempotent v1 migration as required outcomes (`ai/sprints/active/shared-session-registry-v2/BRIEF.md:12`, `ai/sprints/active/shared-session-registry-v2/BRIEF.md:15`, `ai/sprints/active/shared-session-registry-v2/BRIEF.md:17`, `ai/sprints/active/shared-session-registry-v2/BRIEF.md:18`).
- **Blocker:** There is no frozen v2 migration contract in the reviewed evidence. The active plan still labels design as WIP and only names topics such as collision, stale ownership, and migration without defining behavior (`ai/sprints/active/shared-session-registry-v2/PLAN.md:11`, `ai/sprints/active/shared-session-registry-v2/PLAN.md:13`). Implementation should not begin until the invariants below are incorporated.
- **Blocker:** Automatic old/new overlap cannot be made safe with v2 logical-session locks. A v0.1 process ignores those locks, marks the whole manifest dirty during initialization, and later overwrites the whole manifest (`src/session/session-manager.ts:135`, `src/session/session-manager.ts:143`, `src/session/session-manager.ts:626`). It may also keep writing the imported Pi native session file. Migration must use a staged/imported-but-inactive state and an explicit legacy-root retirement barrier.
- **Blocker:** Migration cannot assume one legacy source. README explicitly instructed Claude and Codex to use different roots, and `PI_AGENT_MCP_STATE_DIR` accepts arbitrary paths (`README.md:36`, `README.md:51`, `README.md:55`, `src/server.ts:15`). A single marker in the new shared root would silently strand sessions from other custom roots.
- **Blocker:** Logical session IDs are not the only collision domain. Two roots can contain different IDs pointing to the same `sessionFile` or Pi session ID. Locking only by logical ID would permit two Pi processes to restore one native conversation. Migration must detect canonical native-session identity collisions or enforce an additional ownership lock keyed by native identity.
- **Blocker:** Existing atomic rename behavior is overwrite-capable (`src/store/session-store.ts:76`). Migration record publication requires atomic **create-if-absent**, not rename-over-existing. Existing records must never be replaced merely because an imported generation is higher.
- **Major:** Dirty-state handling is currently manifest-wide: one `cleanShutdown` bit determines recoverability for every session (`src/store/session-store.ts:30`, `src/session/session-manager.ts:137`, `src/session/session-manager.ts:548`). A dirty legacy source must therefore make all imported records inactive until the source is explicitly retired; an apparently idle entry is not independently proven safe.
- **Major:** Current startup conversion replaces the prior `lastTask` when an active task is found (`src/session/session-manager.ts:521`, `src/session/session-manager.ts:526`). The v2 schema must preserve both the original terminal `lastTask` and the synthesized `host_interrupted` task, or preserve the complete original record in provenance. Otherwise the requested `lastTask` survival is not met.
- **Major:** Current validation rejects a corrupt manifest as one unit and does not fully validate optional session/task fields (`src/store/session-store.ts:85`, `src/store/session-store.ts:109`). Migration must retain the raw source, report corruption, and avoid manufacturing an empty successful migration.

## Required Invariants

1. **Source preservation:** Before publishing any migrated record, retain an exact, hash-verified snapshot of the source `sessions.json`. Never delete or rewrite the only copy.
2. **No activation before retirement:** Imported sessions remain `migration_blocked` and cannot be restored or sent work until the corresponding legacy source is retired.
3. **No old/new shared writer:** An old and a new server must never concurrently operate on the same imported Pi `sessionFile`, even when their logical session IDs differ.
4. **No overwrite:** Migration may create a missing record, recognize an exact prior import, or emit a conflict. It must never overwrite an unrelated or subsequently modified v2 record.
5. **Per-source idempotence:** Completion is tracked by canonical source path plus source content hash, not by one global “migration done” flag.
6. **Multi-source completeness:** Default-root discovery and each explicitly supplied custom root receive independent receipts. Importing one root must not suppress later imports from another.
7. **Exact lifecycle preservation:** Preserve `closed`, `generation`, `name`, `cwd`, `model`, `piSessionId`, `sessionFile`, and every `lastTask` field, including empty response/error strings.
8. **Interrupted task preservation:** After confirmed retirement, a legacy active task becomes `host_interrupted` with its original task ID and generation. The previous `lastTask` remains recoverable separately.
9. **Monotonic generation:** The first post-migration dispatch uses the imported generation plus one, under ownership and record compare-and-swap.
10. **Global identity uniqueness:** Active records must be unique by logical session ID, task ID where globally addressable, and canonical native session identity.
11. **Path safety:** Raw legacy IDs must never be used directly as path components. Record and lock paths require a safe encoding or digest.
12. **Durable publication:** Snapshot, intent, record, conflict artifact, receipt, and retirement sentinel require file and containing-directory durability before the next phase is acknowledged.
13. **Ownership before mutation:** Any update to an existing v2 record requires its session/native-identity ownership lock, followed by a fresh record read and generation check.
14. **Conservative stale policy:** Never steal ownership solely because a timestamp expired. If process identity or process-group death is uncertain, return `session_in_use_or_uncertain`.
15. **Closed means closed:** Migration and conflict resolution must never make a v1 `closed` session dormant or recoverable.
16. **Corruption is visible:** Malformed JSON, unknown versions, invalid records, incomplete migration artifacts, and hash changes must be reported; none may be interpreted as an empty source.

## Safest User Behavior

- Discover only the legacy manifest at the new default root automatically. Accept arbitrary old Claude/Codex roots through an explicit repeatable migration option; do not scan the home directory.
- Stage valid records first, but expose them as unavailable with `legacy_source_not_retired`.
- If `cleanShutdown:false`, any record is `legacy_state_uncertain`; do not restore it automatically, regardless of its individual state.
- If the source is corrupt or has an unknown version, preserve its bytes and fail that source with its exact path and diagnostic. Do not claim migration success.
- Require the user to stop all old MCP clients before retirement. After confirmation, re-read and re-hash the source; abort if it changed.
- Retire the source by preserving an immutable v1 backup and atomically replacing `sessions.json` with a version-2 migration sentinel that v0.1 validation rejects. This prevents future old startups from silently recreating the old registry.
- Because an already-running v0.1 process may have loaded the manifest before the sentinel is installed, activation must still rely on the explicit “all old hosts stopped” precondition. The software cannot prove this from v1 metadata.
- Report `migration_conflict`, `migration_in_progress`, `legacy_state_uncertain`, and `legacy_source_not_retired` distinctly rather than collapsing them into `unknown_session` or `session_not_recoverable`.

## Idempotent Algorithm

1. Canonicalize and deduplicate each declared legacy source. Record its original path; reject unsafe symlink/path transitions.
2. Acquire a shared-root migration mutex using an atomic no-replace primitive. Other servers wait boundedly or continue without treating partial migration as complete.
3. Read the source through one file descriptor, verify stable metadata, hash the exact bytes, and create a no-replace backup. Verify the backup hash and sync it.
4. Strictly validate the manifest version and every session/task field. Preserve invalid raw entries as diagnostics; do not emit live records from them.
5. Write a durable migration intent containing source identity, hash, clean/dirty state, expected session IDs, and algorithm/schema version.
6. Process sessions in deterministic ID order. Derive safe record keys independently of raw IDs.
7. Convert each record without changing lifecycle data. Dirty-source records remain inactive; clean but internally inconsistent records are quarantined.
8. Publish each destination through atomic create-if-absent. Never use overwrite-capable rename for the final claim.
9. If a destination exists, apply the conflict policy below. Record every decision in the migration receipt.
10. Detect duplicate canonical `sessionFile`, file identity, or Pi session ID across all staged/live records. Quarantine every newly discovered ambiguous identity.
11. Write and sync a completion receipt only after every source entry has a created, exact-no-op, invalid, or conflict disposition.
12. On retry, reconstruct from the intent, per-record provenance, and receipt. Exact completed work is a no-op; incomplete temporary artifacts are cleaned or resumed without replacing final records.
13. Activation is a separate phase. After explicit old-host shutdown confirmation, verify the source still matches its imported hash, preserve the v1 backup, install the rejection sentinel, and only then change staged records to eligible dormant/closed states.
14. If any activation step fails, imported records remain inactive and the original or verified backup remains usable.

## Conflict Policy

- **Exact same import:** Same source identity, source hash, source-session payload hash, and target record provenance is an idempotent no-op.
- **Existing v2 record evolved after import:** Keep v2 unchanged. Never roll it back to the legacy generation.
- **Same logical ID, different content:** Existing live record wins provisionally; preserve the imported record under a conflict artifact and block automatic activation.
- **Different IDs, same native session identity:** Treat as a conflict, not as two sessions. Neither newly imported alias may start a second Pi process.
- **Same ID and same native identity but divergent metadata:** Do not choose the highest generation automatically. Generations from separate roots are not necessarily comparable.
- **Task ID collision:** Preserve both source payloads, but require deterministic task-ID remapping if the conflicting session is resolved under a new logical ID. Retain legacy IDs as provenance.
- **Resolution choices:** The user may declare records duplicates, retain the existing record, or import the conflict under a deterministic new session/task ID. Resolution must be durable and repeatable.
- **Corrupt existing v2 record:** Never overwrite it with legacy data. Quarantine both the corrupt bytes and incoming candidate for explicit repair.

## Required Tests

- Clean v1 migration preserves every field, empty response/error strings, `generation`, `lastTask`, and `closed`.
- Active legacy task becomes `host_interrupted` only after retirement, while the prior `lastTask` remains recoverable.
- Dirty manifests containing idle, running, closed, and active-task sessions remain inactive before explicit retirement.
- Corrupt JSON, wrong version, malformed optional fields, invalid generation, and mismatched task/session IDs preserve source bytes and report diagnostics.
- Two custom roots import independently; restarting after importing one still discovers/imports the other.
- Same session ID across roots with identical and divergent content exercises exact-no-op and conflict paths.
- Different logical IDs sharing one `sessionFile`, symlink alias, hard-link identity, or Pi session ID cannot both activate.
- Existing newer v2 records are never overwritten; an interrupted migration retry does not roll them back.
- Session and task IDs containing separators, traversal components, Unicode, and extreme lengths cannot escape record/lock directories.
- Fault injection after snapshot, intent, every record create, conflict write, receipt, backup, sentinel installation, and activation proves retry convergence.
- Two OS processes migrate the same source concurrently; one publishes and the other observes the same result without overwrite or duplicate records.
- Source changes between snapshot and activation cause a hard stop and a new source-hash disposition.
- A running fake v0.1 server causes migration/activation to remain blocked; no v2 Pi process restores its session file.
- After retirement, starting v0.1 against the source sees the v2 sentinel and fails before writing.
- Two v2 servers contend for one migrated session; exactly one restores it and the other gets `session_in_use`.
- Owner crash, PID reuse, uncertain process death, lock corruption, and stale-lock recovery never produce two Pi writers.
- First post-migration send increments the imported generation exactly once under concurrent requests.
- Missing or changed Pi native session files yield a diagnostic error without modifying migration provenance.
- Listing/status during partial migration ignores temporary files but surfaces migration diagnostics.
- Disk-full, permission, fsync, and no-replace publication failures leave source and completed records recoverable.
- Supervisor validation should include `npm run typecheck`, full `npm test`, and a real two-server/fake-Pi process E2E.

## Release Blockers

- Freeze a concrete v2 schema, directory layout, migration receipt, activation state, and ownership identity.
- Define explicit multi-source import and discovery behavior.
- Add the staged-import/legacy-retirement barrier; automatic overlap is unsafe.
- Define logical-ID, task-ID, and native-session-identity collision handling.
- Require no-overwrite record publication and crash-resumable receipts.
- Preserve prior `lastTask`, interrupted active task, generation, and closed state.
- Add the adversarial migration and multi-process test matrix above.
- Update README so users know old binaries cannot share an activated migrated source.

## Deliberate Non-Goals

- Live transfer or replay of an executing v0.1 task.
- Automatic recovery of dirty/running legacy sources without user confirmation.
- Simultaneous old/new operation on the same imported Pi native session.
- Automatic discovery of arbitrary historical custom directories.
- Automatic semantic merge of divergent same-ID records.
- Deletion of legacy manifests or Pi native session files.
- Cross-machine or network-filesystem correctness.
- Supporting downgrade to v0.1 on a retired v2 root; the retained backup provides recovery/export instead.

## Residual Risks

- A user can incorrectly confirm that all old hosts are stopped; v1 contains no ownership identity that can disprove this.
- A previously loaded v0.1 process can overwrite a retirement sentinel later, so activation should monitor source hash/sentinel changes and fail closed where possible.
- External tools can mutate Pi native session files outside both v1 and v2 ownership protocols.
- Filesystem atomicity and durability assumptions may not hold on network or unusual filesystems; those should be explicitly unsupported.
