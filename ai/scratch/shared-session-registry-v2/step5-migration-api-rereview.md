# Step 5 migration/API re-review

Verdict: FAIL — 0 Blocker, 1 Major, 4 Minor.
Reviewer run: `1064878e`.

## Major: stale wait can reconcile the wrong active task

Remote wait pins only a session ID. Before reconciliation it does not require the fresh record's `activeTaskId` to equal the requested task ID. If the requested current/last slot is overwritten, waiting for the obsolete ID can reconcile a newer active task to `host_interrupted` and only then return `unknown_task`. Require exact target equality before reconciliation; stale non-owned local tasks must resolve from current disk slots. Test overwrite between discovery and polling and mixed local/remote `any`/`all` waits.

## Minor findings

1. Ownership path failures before the acquire normalization block can leak absolute lock paths through MCP. Normalize `unsafe_path` failures from ownership operations to `ownership_unavailable`.
2. `running` with `activeTaskId:null` remains schema-valid; reject this impossible durable combination.
3. Add direct mixed local/remote wait tests for both `any` and `all`.
4. README should say identity-less error close is logical-only; native fencing is required whenever native identity exists.

## Verified

Known legacy-root guidance, identity-less close/native fencing, corruption-tolerant startup, real dual-stdio E2E, 0600/UID enforcement, most lifecycle validation, exact tool schema snapshot, deterministic retired naming plus legacy intent compatibility, migration source atomicity, and required path-bearing corrupt-record diagnostics are correct. Platform matrix and frozen cooperative/current-last/orphan boundaries remain residuals.
