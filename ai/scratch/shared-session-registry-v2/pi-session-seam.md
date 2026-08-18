# Code Context

## Files Retrieved
1. `src/store/session-store.ts` (lines 7-31, 43-75, 78-124) - Current gateway record schema, atomic manifest persistence, and validation.
2. `src/session/session-manager.ts` (lines 45-56, 157-179, 186-207, 328-343, 510-558, 626-628, 693-750) - Logical/native identity split, restore path, restart behavior, and persisted task outcome.
3. `src/rpc/types.ts` (lines 15-19, 44-47) - Pi RPC state fields and path-based `switch_session` command.
4. `src/rpc/pi-rpc-process.ts` (lines 210-213) - Gateway sends `switch_session` with `sessionPath`.
5. `ai/specs/2026-08-18-pi-subagent-pool-design.md` (lines 71-87, 115-163) - Frozen v1 decision that Pi owns conversation history while gateway owns mapping and task metadata.
6. `ai/sprints/active/shared-session-registry-v2/BRIEF.md` (lines 1-28) - Registry v2 requires per-session records and cross-process ownership.
7. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md` (lines 1-41, 123-139) - Documented native layout and exact header examples.
8. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md` (lines 1-24) - CLI supports path, full ID, and partial ID, but not via an index.
9. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts` (lines 5-13, 84-99, 116-119, 156-183) - Exact `SessionHeader`, `SessionInfo`, discovery, and manager APIs.
10. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` (lines 238-259, 265-318, 395-408) - Directory encoding, bounded header scan, validation, and recent-session lookup.
11. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` (lines 430-529, 540-574) - Listing streams every JSONL to derive name/messages and silently skips failures.
12. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` (lines 596-669) - Opening preserves header ID; new sessions create a new ID and filename.
13. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js` (lines 1170-1222, 1275-1339) - Open-by-path, per-directory listing, and global traversal.
14. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js` (lines 185-212) - ID resolution enumerates local then all native session files.
15. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js` (lines 105-145) - `switchSession` cancellation, path opening, cwd validation, teardown, and full runtime replacement.
16. `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js` (lines 465-479) - RPC delegates path directly and rebinds after a successful switch.

## Key Code

### Native Header and Identity

Pi 0.84.1 declares:

```ts
interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}
```

Evidence: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:5`.

Concrete JSONL header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path","parentSession":"...optional..."}
```

Evidence: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md:123`.

Findings:

- The native ID is stored in the header and copied into `SessionManager.sessionId` when opening a file, so it is stable across close/open and `switch_session`: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:614`.
- Legacy migration may rewrite the file, but the loaded header ID remains the manager identity: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:631`.
- `/new`, `/fork`, and `/clone` intentionally create a new native ID and usually a new file. They are new logical native sessions, not stable continuations of the old ID: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:645`, `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1249`.
- `name` and `model` are **not header fields**. Name is derived from the latest `session_info` entry; model is represented by model-change/message data: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:430`.
- Pi permits caller-provided IDs through `NewSessionOptions.id`, so native ID uniqueness depends on normal UUID generation or external discipline; do not treat it as a filesystem-enforced unique key: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:14`.

### Native Layout and Discovery

Default path encoding is:

```text
<agentDir>/sessions/--<resolved-cwd-with-leading-separator-removed-and-/,\,:-replaced-by->--/
  <ISO-timestamp-with-:-and-.-replaced-by->_<session-id>.jsonl
```

Evidence: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:242` and `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:650`.

- `SessionManager.list(cwd)` scans only the encoded cwd directory.
- `SessionManager.listAll()` enumerates every immediate directory/symlink under the native sessions root, then every `.jsonl` within each: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1290`.
- Each candidate is streamed in full to derive latest name, message count, first message, all searchable message text, and activity time: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:430`.
- CLI ID lookup calls `list`, then `listAll`, and searches exact ID before prefix ID. There is no ID-to-path index: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/main.js:185`.
- The ID is also embedded in default filenames, but custom `--session <path>`, custom session directories, renames, and copied files mean filename inference is not authoritative.

**Answer:** A native session cannot be reliably and cheaply found by ID alone without either a gateway index or scanning/parsing Pi’s native directories. Pi’s own ID lookup is precisely such a scan.

### `switch_session` Expectations

- RPC contract requires `sessionPath`, not a native session ID: `src/rpc/types.ts:46`.
- Pi opens that path with `SessionManager.open`, reads the file/header, validates that the session cwd exists, tears down the current runtime, creates a replacement runtime bound to the restored cwd/session, and can be cancelled by a pre-switch extension hook: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.js:128`.
- Successful RPC switching triggers session rebind: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:473`.
- Current gateway correctly restores by stored absolute `sessionFile`, then verifies returned `sessionFile` equality and refreshes `piSessionId`: `src/session/session-manager.ts:328`.
- The current gateway launches Pi in stored `cwd`; Pi then replaces runtime cwd with the header cwd. A stale gateway cwd can therefore affect initial process configuration/model/resource loading before switching, even though the restored runtime ultimately uses native header cwd.

### Recommended Minimal Record Schema

```ts
interface SessionRecordV2 {
  version: 2;
  sessionId: string;          // Stable gateway/public identity and record key
  generation: number;

  sessionFile: string;        // Required durable discovery/restore seam
  piSessionId: string;        // Integrity/diagnostic check against JSONL header
  cwd: string;                // Dispatch/process setup and user-visible metadata
  name?: string;              // Gateway display identity; avoid native full-file scan
  model?: string;             // Requested/default model policy for process creation

  state: "dormant" | "idle" | "running" | "error" | "closed";
  activeTaskId: string | null;
  lastTask?: {
    taskId: string;
    status: "completed" | "failed" | "aborted" | "host_interrupted";
    response?: string;
    error?: string;
    completedAt: string;
  };
}
```

Registry v2 should additionally keep ownership/lease data beside or atomically associated with this per-session record, as required by the sprint, but ownership is concurrency metadata rather than native discovery metadata.

Why each requested field remains gateway-owned:

- `sessionFile`: indispensable; it is the actual `switch_session` key.
- `piSessionId`: detects path-to-wrong-file replacement/copy and supports diagnostics; validate against restored `get_state`.
- `cwd`: required before restoration to spawn the RPC process and is cheap to list without native scans.
- `name`: native name requires scanning entries and may differ from gateway-assigned worker name.
- `model`: absent from the native header and needed to recreate process/model selection policy.
- Task outcome: Pi conversation history does not encode gateway `taskId`, terminal classification, waiter response, host interruption, or publication durability.

## Architecture

The gateway has two identity layers:

1. Public gateway ID, generated as `pi_<id>`, keys API calls and persisted records: `src/session/session-manager.ts:157`.
2. Native Pi ID, read from Pi RPC state/header, identifies the JSONL conversation but does not locate it without scanning: `src/session/session-manager.ts:339`.

The durable seam is therefore:

```text
gateway sessionId
  -> per-session gateway record
  -> absolute sessionFile + expected piSessionId
  -> Pi switch_session(sessionFile)
  -> get_state verification
```

The native JSONL remains authoritative for conversation content, cwd recorded at creation, and Pi-native session identity. The gateway record remains authoritative for public identity, direct discovery, ownership, launch policy, lifecycle, and gateway task outcomes.

## Review Findings

- **Major:** Native Pi ID alone is not a sufficient registry key. Pi resolves it by full enumeration and parsing, while RPC restoration requires a path. Registry v2 must persist `sessionFile`.
- **Major:** Scanning `~/.pi/agent/sessions` is unsuitable as the normal gateway discovery path. It is O(files + file contents), reads potentially sensitive conversation text, follows top-level symlinked directories, races active writers/deletion, and silently omits corrupt/unreadable files.
- **Major:** Native scans cannot reconstruct gateway task semantics, ownership, logical names, or requested model policy. Removing gateway per-session metadata would make reliable `pi_wait`, recovery, and concurrency control impossible.
- **Moderate:** `switch_session` can be cancelled by extensions and performs full runtime replacement. Ownership must be acquired before switching and held through restored-state verification.
- **Moderate:** A stored path may be replaced with another valid Pi file. Verify both normalized/canonical path policy and `get_state.sessionId === piSessionId`; current code verifies only returned path before replacing its stored native ID.
- **Moderate:** Native IDs can be explicitly supplied and files can be copied. Do not assume global uniqueness without checking `(piSessionId, sessionFile)` consistency.
- **Minor:** Native cwd directory encoding is lossy and implementation-specific. Never reverse it to recover cwd; use the record/header.
- **Minor:** Native `name` is entry-derived, not header metadata. Gateway worker names should remain in the record unless explicit synchronization semantics are designed.

## Residual Risks

- Pi’s native session schema and directory algorithm are upstream implementation details and may change after 0.84.1; gateway records should be versioned and path-based restore should remain verified through RPC state.
- Absolute session paths can become stale after users move/delete native files or change `PI_AGENT_DIR`; recovery should surface `session_not_recoverable`, not silently scan and bind another match.
- Canonicalizing paths with `realpath` can conflict with intentionally symlinked session directories; the ownership design must define lexical versus canonical path identity.
- Pi’s native listing catches errors and returns partial/empty results, so any explicit repair/import scan must report omissions rather than inherit silent best-effort semantics.
- Native JSONL can be modified concurrently by another Pi process unless registry ownership covers every gateway restore/write path; it cannot protect unrelated standalone Pi processes.

## Start Here

Open `src/session/session-manager.ts:328` first. It contains the existing durable restore seam and shows exactly where registry v2 must supply `sessionFile`, enforce ownership, and verify the restored native identity.
