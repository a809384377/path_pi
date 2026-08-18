# Step 2 implementation handoff

Date: 2026-08-18
Status: DONE after independent review remediation

## Implemented
- `SessionRecordStore` is the primary per-session v2 API.
  - Domain-separated SHA-256 final names.
  - Durable private root/sessions/tmp directory creation with parent-directory fsync.
  - Current-user 0700 enforcement plus component-by-component no-symlink checks below documented trusted host anchors.
  - Atomic no-replace create through synced same-directory temp + hard link.
  - Expected-revision owned updates through synced temp + atomic rename.
  - No-follow opened-fd reads with lstat/fstat identity checks.
  - Per-session local queues and `drain(sessionId?)`.
- Legacy v1 manifest store moved to `legacy-session-store.ts` and remains re-exported only as the Step 3 compatibility bridge. Legacy task/lifecycle schema is now strict.
- `readPiSessionIdentity(path)` validates a no-follow regular descriptor, first physical line <=64 KiB, supported versions 1–3, Pi ID, absolute cwd and dev/inode path identity.
- `secure-fs.ts` centralizes durable private directory creation, secure reads, atomic no-replace publication and atomic replacement.
- `V1SessionMigrator` provides source-atomic fail-closed migration:
  - exact immutable backup and transaction intent;
  - intent-bound high-entropy quarantine transition, post-transition hash verification and mismatch preservation;
  - per-record payload hashes, source-session hashes and Pi identity snapshots;
  - source replacement/reappearance and quarantine destination conflict rejection;
  - dirty opt-in and active-task interruption;
  - locked revalidation of imported and every existing V2 declared Pi session file, regardless of recoverability;
  - source-level conflict preflight;
  - crash resume and revision-advanced descendant acceptance without overwrite;
  - completed receipt validation last against intent, backup, quarantine and every destination;
  - strict transaction/root/artifact no-symlink/private-path rules;
  - canonical-only automatic discovery helpers.

## Step 3 public interfaces
- `SessionRecordStore(root)`:
  - `create(record)`
  - `read(sessionId)`
  - `updateOwned(sessionId, expectedRevision, next)`
  - `list()`
  - `drain(sessionId?)`
  - `recordPath(sessionId)`
- Types: `SessionRecordV2`, `SessionRecordState`, `MigrationProvenance`, `SessionRecordStoreApi`.
- `readPiSessionIdentity(path): Promise<PiSessionIdentity>` returns actual native identity and dev/inode.
- `MigrationCandidateLockCoordinator.withCandidateLocks(candidates, operation)` is mandatory.
- `orderedMigrationCandidates()` emits the required hierarchy: global migration -> canonical source -> sorted logical -> sorted native.
- `V1SessionMigrator({ root, recordStore, coordinator, allowDirty })`:
  - call `resumeIncomplete()` before live discovery;
  - call `migrateSource(path)` for discovered sources.
- Helpers: `canonicalDefaultStateRoot`, `automaticMigrationEnabled`, `discoverLegacySources`, `migrationIdentifier`.

## Validation
- `npm run typecheck`: pass.
- `npm run build && node --test dist/test/session-record-store.test.js dist/test/pi-session-header.test.js dist/test/v1-migration.test.js`: 39/39 pass.
- `npm test`: 74/74 pass.
- `git diff --check`: pass.

## Deliberate Step 3 boundaries / residual risks
- No real flock coordinator exists yet; migration throws `ownership_unavailable` without injection.
- `updateOwned` assumes the caller already holds logical ownership.
- SessionManager/server remain on the legacy compatibility alias until Step 3/4.
- High-entropy quarantine no-overwrite relies on the frozen cooperative/private-root threat model and global migration lock; hostile same-UID races are explicitly out of scope.
- Tests cover deterministic process interruption/races but not physical power-loss fault injection.
- Pi header versions are explicitly 1–3.

Review verbatim and disposition: `ai/scratch/shared-session-registry-v2/step2-review.md`.
