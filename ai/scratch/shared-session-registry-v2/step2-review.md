## Review

**Result: NOT PASS** — 1 Blocker, 5 Major, 1 Minor remain. Runtime ownership integration is intentionally deferred, but the findings below are Step 2 storage/migration defects rather than Step 3 omissions.

### Correct

- `SessionRecordStore.create()` uses the required hard-link no-replace publication primitive: synced private temp, `link(temp, final)`, temp unlink, then sessions-directory fsync (`src/store/session-store.ts:121-125`). The two-instance collision test exercises this (`test/session-record-store.test.ts:37-50`).
- Local same-session writes are queued, stale revisions are rejected, and revisions must advance exactly once (`src/store/session-store.ts:85-96`, `src/store/session-store.ts:135-147`; `test/session-record-store.test.ts:52-69`).
- Migration provenance is immutable during owned updates (`src/store/session-store.ts:139-141`).
- The header parser correctly restricts identity to the first physical line, enforces the 64 KiB boundary, uses `O_NOFOLLOW` for the final component, checks regular-file status, and compares opened/path device and inode (`src/store/pi-session-header.ts:17-66`). Later malformed entries do not affect identity (`test/pi-session-header.test.ts:22-29`).
- Exact same-revision records and revision-advanced records with unchanged logical/native/path/provenance identity are accepted without overwrite (`src/store/v1-migration.ts:472-481`; `test/v1-migration.test.ts:181-210`).
- The dirty-source opt-in and active-task interruption behavior are present. Resuming a previously attested durable intent without requiring the environment variable again is consistent with the specified one-time attestation.
- Conflict preflight occurs while inside the candidate-lock coordinator, and logical/native intra-source conflicts are aggregated before source retirement (`src/store/v1-migration.ts:229-247`, `src/store/v1-migration.ts:313-333`).

### Blocker

- **Retirement is vulnerable to a checked-file/renamed-file race and can retire newer bytes while publishing the old snapshot.**  
  Locations: `src/store/v1-migration.ts:251-260`, `src/store/v1-migration.ts:579-584`.

  Deterministic scenario:

  1. Migrator reads legacy source bytes **A** at line 251 and confirms hash **HA** at line 256.
  2. It awaits the intent rewrite at line 258.
  3. During that await, a legacy writer atomically renames source bytes **B** over `sessions.json`.
  4. Line 259 calls `retireSourceNoReplace`; line 583 renames the current path—now **B**—to a filename claiming **HA**.
  5. The code does not hash the retired file after rename and proceeds to publish records derived from **A**, then writes a completed receipt claiming the retired file also has **HA**.

  The newest legacy state is removed from the live path, the receipt lies about the retired artifact, and stale records become active. This violates source-hash revalidation, source atomicity, and fail-closed retirement.

  There is a second atomicity defect in the same helper: `exists(retiredPath)` followed by overwrite-capable `rename(sourcePath, retiredPath)` is not no-replace. A destination created between lines 579 and 583 is silently overwritten. Retirement needs an identity/hash-stable source transition plus a truly no-replace destination strategy.

### Major

- **Migration artifacts are published directly under their final names, so a crash can leave a permanently torn backup, intent, or receipt. Newly created parent-directory entries are also not durably fsynced.**  
  Locations: `src/store/v1-migration.ts:172-175`, `src/store/v1-migration.ts:303`, `src/store/v1-migration.ts:602-612`; analogous directory durability gap at `src/store/session-store.ts:154-159`.

  Deterministic scenarios:

  - Process dies after `open(...O_EXCL)` at line 604 and after a partial `writeFile`, but before `sync`. A partial `intent.json` now exists. `resumeIncomplete()` attempts to parse it and fails forever; a new migration sees the existing intent and takes the same failed resume path.
  - Process dies while directly writing `receipt.json`. On restart, `resumeIncomplete()` merely sees that the receipt path exists and skips the transaction (`src/store/v1-migration.ts:114-118`), hiding the corrupt receipt.
  - A new `migrations/v1-...` or `sessions/` directory is created, but its parent is never fsynced. A power failure after source retirement can lose the transaction-directory entry even though child files were individually synced, leaving no discoverable intent.

  No-replace artifacts need temp-write/fsync plus atomic no-replace publication, and every newly created directory entry needs its parent directory fsynced before retirement can occur.

- **Intent and receipt validation is not bound to the immutable source snapshot or staged payload hashes.**  
  Locations: `src/store/v1-migration.ts:216-224`, `src/store/v1-migration.ts:232-239`, `src/store/v1-migration.ts:484-533`.

  Deterministic intent scenario:

  1. Crash immediately after source retirement.
  2. Change only `intent.records[0].cwd`, `name`, lifecycle fields, or task contents while leaving the migration provenance fields intact.
  3. `validateIntent()` validates the modified record schema and provenance strings but never recomputes the staged records from `source.json`, verifies `sourceSessionHash`, or checks a staged payload hash.
  4. Resume publishes the modified record.

  Deterministic receipt scenario:

  1. A syntactically valid corrupt receipt retains the derived migration/source/retired fields but contains an empty or incomplete `publishedSessionIds`.
  2. The early receipt branch at lines 232-239 reports `already_complete` without comparing the receipt with the intent or validating every destination.
  3. `resumeIncomplete()` skips any receipt before even parsing it at line 116.

  The spec requires all staged payloads/hashes in the intent and completed-receipt validation last. Current tests mutate only provenance and an invalid published ID (`test/v1-migration.test.ts:245-267`), so they do not cover valid-schema payload alteration, incomplete-but-valid receipts, or torn receipts.

- **Legacy schema validation is weaker than the V2 record validator, allowing the source to be retired before an unpublishable staged record is discovered.**  
  Locations: `src/store/legacy-session-store.ts:123-135`, `src/store/v1-migration.ts:155-175`, `src/store/v1-migration.ts:281-290`.

  Exact source:

  ```json
  {
    "version": 1,
    "cleanShutdown": true,
    "sessions": {
      "alpha": {
        "sessionId": "alpha",
        "generation": 1,
        "cwd": "/tmp",
        "state": "idle",
        "activeTaskId": null,
        "lastTask": {
          "taskId": "",
          "sessionId": "alpha",
          "status": "completed",
          "response": 7,
          "completedAt": "not-a-date"
        }
      }
    }
  }
  ```

  `validateManifest()` accepts this because it checks only that `taskId` and `completedAt` are strings and does not validate `response`/`error`. Conversion stages it without calling `validateSessionRecord`. The source is then retired; only `SessionRecordStore.create()` rejects the blank task ID, invalid date, or numeric response. Every resume repeats the same failure. Strict V1 validation or complete staged-record validation must happen before intent readiness and retirement.

- **Native conflict preflight trusts existing record metadata rather than the existing Pi file’s actual first-line identity.**  
  Locations: imported-file parsing at `src/store/v1-migration.ts:361-371`; conflict check at `src/store/v1-migration.ts:323-331`.

  Deterministic scenario:

  1. Existing V2 logical record `beta` claims `piSessionId: "native-B"` and points to a regular JSONL whose first header says `id: "native-A"`.
  2. The imported V1 source contains logical record `alpha` whose validated JSONL header also says `native-A`.
  3. Preflight compares the imported actual ID to existing metadata `"native-B"` and sees no conflict.
  4. It retires the entire V1 source and publishes `alpha`, despite the required actual-native conflict.

  The imported header is also parsed before candidate locks are acquired and never revalidated afterward. Replacing that path with a different valid header between `readPiSessionIdentity()` and `withCandidateLocks()` publishes a stale `recoverable: true` identity. The parser’s own opened-fd check is sound, but migration must revalidate the path/header identity under candidate locks before retirement.

- **Registry and migration storage paths do not enforce the spec’s no-symlink/private-root rules.**  
  Locations: `src/store/session-store.ts:73-80`, `src/store/session-store.ts:154-159`, `src/store/v1-migration.ts:104-118`, `src/store/v1-migration.ts:425-426`, `src/store/v1-migration.ts:646-653`.

  Deterministic scenarios:

  - Pre-create `<root>/sessions` as a symlink to another same-filesystem directory. Recursive `mkdir` accepts it, and record hard links/read/list operations occur through that symlink.
  - Make a final hashed record path a symlink to a schema-valid external JSON record. `readFile()` follows it; there is no `O_NOFOLLOW`, `fstat`, or `lstat` identity check.
  - Make `<root>/migrations` or a transaction directory a symlink. `readdir`, `stat`, `readFile`, and artifact writes all traverse it.
  - Make the lexical default root `~/.pi/agent-mcp` a symlink elsewhere. `automaticMigrationEnabled()` uses only `resolve`, not verified physical/no-symlink identity, and enables automatic consolidation into the symlink target.

  These are contrary to the explicit requirement to reject symlinks component-by-component and verify opened/path identity. The test suite covers only a symlink at the final Pi JSONL component (`test/pi-session-header.test.ts:54-64`), not registry roots, record files, migration directories, intents, receipts, or source paths.

### Minor

- **The candidate-lock abstraction supplies a misleading global order.**  
  Location: `src/store/v1-migration.ts:458-469`.

  Lexical sorting yields `logical:*`, `migration:*`, `native:*`, `source:*`, whereas the protocol requires global migration lock, then canonical source lock, then globally ordered logical/native candidates. The in-process coordinator ignores the candidate list, so tests cannot detect this. Production kernel lock acquisition is intentionally Step 3, but Step 3 must rank lock domains itself rather than acquire in the supplied array order; preferably the abstraction should encode the hierarchy now.

### Intentional Step 3/4 deferrals, not Step 2 findings

- Cross-process exclusion for `updateOwned()` is intentionally supplied by logical ownership later. Two store instances can currently both read revision 1 and rename revision 2, but that is acceptable only because the method’s contract requires the caller to already hold ownership.
- Production kernel flock implementation, inherited Pi descriptors, logical→native runtime ownership, process-group release sequencing, crash reconciliation, dynamic status, and runtime write-queue shutdown integration are deliberately deferred.
- The current in-process candidate coordinator is test-only; lack of real cross-process locks is not independently reported as a Step 2 defect.
- Runtime `SessionManager` still using the legacy alias is the documented Step 3/4 bridge and is not reviewed as an integration regression here.

### Residual risks and required validation

- The three new test files cover happy-path no-replace creation, ordinary parser rejection, source change before hash recheck, post-retirement resume, and evolved descendants. They do not cover the deterministic races and crash states above.
- Add tests for: replacement after hash recheck but before retirement; competing retired destination; partial initial intent/receipt; transaction-parent durability abstraction; valid-schema staged-payload corruption; incomplete valid receipt; malformed receipt discovery; weak legacy task fields; existing record metadata/header mismatch; Pi file replacement before candidate locks; and symlinked root/sessions/migrations/final record.
- No commands were run because this assignment was read-only and no shell execution tool is available. The supervisor should rerun `npm run typecheck`, the three focused test files, full `npm test`, and `git diff --check` after corrections.
- Staging state could not be verified without Git command access.
---

## Disposition after review

All findings accepted and fixed in Step 2.

1. **Blocker — retirement race/no-replace:** replaced deterministic rename target with an intent-bound high-entropy quarantine transition. The transitioned file is read through a no-follow fd and hashed after rename; mismatch enters durable `quarantined_mismatch`, preserves immutable A backup plus quarantined B, and never publishes records. A reappeared live source or competing quarantine destination also fails closed. Regression tests inject replacement after the final pre-transition intent write and a competing destination.
2. **Major — artifact atomicity/directory durability:** added `secure-fs.ts`. Backup, initial intent, conflict and receipt use synced private temp + hard-link no-replace publication; mutable intent progress uses synced temp + atomic rename. Every newly created private directory is followed by parent-directory fsync. Session root/sessions/tmp use the same durable private-directory creation.
3. **Major — immutable transaction binding/receipt validation:** intent is cross-bound to transaction directory, exact source backup hash, recomputed source-session hashes, exact staged records, per-record payload hashes, identity snapshots and immutable provenance. Completed receipt is parsed last and must exactly cover every staged/published record; every actual destination, including revision-advanced descendants and recoverable Pi header identity, is revalidated.
4. **Major — weak legacy schema:** task ID must be non-empty, completedAt parseable, response/error strings, active task ID non-empty; every converted V2 record is validated before intent publication or source transition.
5. **Major — actual-native conflict:** imported Pi identity snapshots capture header/native/dev/inode before staging and are re-read under candidate locks. Existing recoverable V2 records are checked from actual first-line headers; metadata/header mismatch and actual-native collisions fail before source transition.
6. **Major — private/no-symlink paths:** root/sessions/tmp/migrations/transactions require current-user 0700 directories and reject symlinks; record/artifact/source reads use no-follow opened descriptors plus lstat/fstat identity; source parent and automatic canonical root symlinks are rejected.
7. **Minor — lock hierarchy:** `orderedMigrationCandidates()` explicitly emits migration, source, sorted logical, sorted native domains. Regression test captures coordinator input and asserts exact hierarchy/order.

Validation after disposition:
- `npm run typecheck`: PASS
- focused Step 2 tests: 34/34 PASS
- `npm test`: 69/69 PASS
- `git diff --check`: PASS

---

# Follow-up review 516bf324 (verbatim)

## Review

**Result: NOT PASS** — 2 Major findings remain. The prior retirement, artifact, binding, strict-validation, imported-identity, and ordering defects are substantially fixed, but no-symlink enforcement and actual-native conflict detection are still incomplete.

### Correct — prior findings verified as resolved

- **Retirement replacement/stale activation before transition:** fixed for the reviewed race. After the final hash check, the source is moved to an intent-bound unique quarantine, reopened with `O_NOFOLLOW`, rehashed, and checked for immediate source reappearance before any record publication (`src/store/v1-migration.ts:237-258`). Replacement injected immediately before transition is quarantined and never activated (`test/v1-migration.test.ts:238-267`).
- **Competing quarantine known before transition:** fails closed without overwriting (`src/store/v1-migration.ts:645-648`; `test/v1-migration.test.ts:269-288`). The remaining `lstat`→`rename` atomicity caveat is discussed under residual risks because production candidate locks and the high-entropy destination are part of the cooperative threat model.
- **Atomic durable artifacts:** `publishNoReplace()` now uses same-directory private temp creation, file fsync, hard-link no-replace publication, temp unlink, and directory fsync (`src/store/secure-fs.ts:70-88`). Mutable intent progress uses synced-temp atomic replacement (`src/store/secure-fs.ts:91-108`).
- **Directory durability:** successful directory creation is followed by parent-directory fsync (`src/store/secure-fs.ts:23-30`), and the record store and migration root both use this helper (`src/store/session-store.ts:147-151`, `src/store/v1-migration.ts:486-489`).
- **Immutable staged payload binding:** resume validates the exact backup hash, reparses the manifest, deterministically recomputes every staged V2 record, compares payload hashes, validates identity-snapshot coverage, and reruns V2 validation (`src/store/v1-migration.ts:337-367`). Valid-schema intent tampering is covered (`test/v1-migration.test.ts:290-324`).
- **Receipt-last validation:** a receipt must exactly match the intent’s migration/source/quarantine identity, payload-hash map, complete ordered record ID list, and complete intent progress; the quarantined source and all destinations are then revalidated (`src/store/v1-migration.ts:306-335`). Malformed and incomplete receipts are no longer silently skipped (`test/v1-migration.test.ts:368-387`).
- **Strict legacy validation before retirement:** legacy tasks now require a nonempty task ID, parseable completion time, and string response/error; active task IDs must also be nonempty (`src/store/legacy-session-store.ts:88-97`, `src/store/legacy-session-store.ts:126-140`). Conversion calls `validateSessionRecord()` before intent publication (`src/store/v1-migration.ts:538-579`). Invalid legacy task cases leave the live source intact (`test/v1-migration.test.ts:389-402`).
- **Imported native identities under candidate locks:** initial device/inode/header snapshots are staged, then the path is reopened and header/native/device/inode are compared after candidate locks are acquired (`src/store/v1-migration.ts:218-224`, `src/store/v1-migration.ts:369-390`). The replacement-under-lock test is deterministic (`test/v1-migration.test.ts:426-443`).
- **Explicit lock hierarchy:** candidates are emitted as migration, source, sorted logical IDs, then sorted native IDs (`src/store/v1-migration.ts:528-535`; `test/v1-migration.test.ts:445-466`).
- **Unique-quarantine data preservation:** a hash mismatch durably enters `quarantined_mismatch`; immutable snapshot A remains in `source.json`, transitioned bytes B remain in quarantine, and no records are published (`src/store/v1-migration.ts:245-254`). Resume remains fail-closed for that state (`src/store/v1-migration.ts:217-220`).

### Major

- **No-symlink enforcement checks only the first existing leaf, not every path component.**  
  Locations: `src/store/secure-fs.ts:6-32`, `src/store/secure-fs.ts:35-43`; affected callers include `src/store/session-store.ts:67-73`, `src/store/session-store.ts:147-151`, and `src/store/v1-migration.ts:486-489`.

  Deterministic scenario:

  1. Create `/tmp/registry-external/state` as a real current-user `0700` directory.
  2. Create `/tmp/registry-parent/alias` as a symlink to `/tmp/registry-external`.
  3. Construct `SessionRecordStore("/tmp/registry-parent/alias/state")`.
  4. `ensurePrivateDirectory()` starts with `lstat("/tmp/registry-parent/alias/state")`. Because only the intermediate `alias` component is a symlink, `lstat` follows it and reports the final `state` directory as regular.
  5. The loop stops at line 14 without examining `alias`; `assertPrivateDirectory()` repeats only the final-component check.
  6. `sessions`, `tmp`, records, and migration artifacts are created through the symlink outside the lexical private root.

  The new tests cover a symlink as the root leaf, `sessions` leaf, migration-directory leaf, transaction leaf, and final artifact (`test/session-record-store.test.ts:113-142`, `test/v1-migration.test.ts:468-513`), but not an intermediate ancestor with a regular final directory already present. This does not satisfy the frozen component-by-component no-symlink rule. The secure helper must walk and `lstat` every component from an accepted anchor or establish an equivalent verified `realpath` policy.

- **Existing non-recoverable records still use claimed native metadata instead of an actual header, allowing an actual-native conflict to retire the source.**  
  Location: `src/store/v1-migration.ts:400-415`.

  Deterministic scenario:

  1. Existing V2 record `beta` is schema-valid with:
     - `state: "error"`
     - `recoverable: false`
     - `piSessionId: "native-beta"`
     - `sessionFile: "/tmp/existing.jsonl"`
  2. `/tmp/existing.jsonl` is a regular no-symlink Pi file whose strict first header has `id: "native-alpha"`.
  3. The staged V1 record `alpha` also has actual header ID `native-alpha`.
  4. At line 405, preflight initializes `actualNative` to claimed metadata `native-beta`. Because `recoverable` is false, lines 406-410 never read the existing file.
  5. No native conflict is reported; the V1 source is quarantined and `alpha` is published, despite an existing logical record whose file has the same actual native identity.

  `SessionRecordV2` permits identity fields on non-recoverable/error records, so this is not rejected by schema validation. The revised regression test covers only `recoverable: true` (`test/v1-migration.test.ts:404-424`). The frozen migration rule requires actual Pi-header native identity or fail-closed uncertainty, not metadata trust based on recoverability. Any existing record with a declared `sessionFile` should be strictly inspected under candidate locks; missing, invalid, or metadata-mismatched identity should block retirement.

### Minor

- **Concurrent directory creation has a narrow physical-power-loss durability gap on the `EEXIST` path.**  
  Location: `src/store/secure-fs.ts:23-30`.

  If process A successfully creates a directory but pauses before syncing its parent, process B receives `EEXIST`, skips the parent fsync, and can continue using the directory. A machine-wide power loss before A resumes can lose the parent entry even though B progressed. This is not a normal process-crash defect—the successful creator will ordinarily execute the fsync—and no physical fault-injection tests were required, but syncing the parent after both successful creation and accepted `EEXIST` would remove the dependency.

### Unique-quarantine threat-model assessment

- An old V1 writer can theoretically recreate `sessions.json` after the immediate absence check at `src/store/v1-migration.ts:246` but before publication starts at `src/store/v1-migration.ts:274`. Completed validation eventually detects the reappeared source, but records may already have been published. This is **not classified as a Step 2 defect under the frozen migration precondition**: users must stop all legacy clients, and V1 writers do not participate in the V2 lock protocol. The immediate check is defense-in-depth, not a software proof that an uncooperative V1 writer cannot restart.
- Production cross-process serialization of the global/source/logical/native candidates remains Step 3. The Step 2 candidate ordering is now correct, but the production coordinator should deduplicate native keys before opening/flocking them or treat the input as a set.
- The `pathExists(quarantine)` followed by overwrite-capable `rename` is not intrinsically atomic no-replace. Under the frozen private-root/cooperative model, the destination is intent-bound with a fresh UUID and compliant migrators will be serialized by the Step 3 coordinator, so no in-scope actor should create it in that interval. A malicious same-UID process is explicitly out of scope.

### Residual risks

- True machine power-loss behavior remains filesystem-dependent and is not demonstrated by process-level hook tests.
- Step 3 must provide real cross-process candidate locks; the in-process coordinator does not establish cross-server exclusion.
- Runtime ownership, inherited lock descriptors, release ordering, crash reconciliation, and dynamic runtime integration remain intentional Step 3/4 deferrals.
- No commands were run in this read-only review because no shell execution tool was available. The disposition’s reported `34/34` focused and `69/69` full-suite passes were inspected as prior evidence but not independently attested here.
- Git staging state could not be verified.
---

## Disposition after follow-up 516bf324

All three follow-up findings were accepted and fixed without entering Step 3 scope.

1. **Major — intermediate ancestor symlinks:** `secure-fs.ts` now selects and documents an accepted host anchor policy. The OS/user-established home, Node host temp directory, `/tmp`, and `/var/tmp` are accepted anchors (allowing the macOS `/tmp -> /private/tmp` alias); outside them the filesystem root is the anchor. Every lexical component below the selected anchor is walked with `lstat`, before and after relevant file operations, and any symlink is rejected. Session records, migration roots/sources/artifacts and Pi JSONL identity reads use this policy. Regression tests use a regular final directory/file reached through an intermediate symlink, plus an explicit `/tmp` anchor case.
2. **Major — non-recoverable existing session files:** migration preflight now strictly opens every existing record's declared `sessionFile` under the candidate-lock operation regardless of `recoverable`. Missing, malformed and metadata/header mismatch fail closed while leaving the V1 source live; the actual header ID drives native conflict detection. Completed-destination validation uses the same rule. Tests cover recoverable:false mismatch, missing, malformed and actual-native conflict.
3. **Minor — EEXIST directory durability:** `ensurePrivateDirectory()` now validates the accepted concurrent `EEXIST` directory and fsyncs its parent before proceeding, just as for the successful creator. A concurrent eight-caller directory creation regression exercises the path and verifies the private result.

Validation after follow-up disposition:
- `npm run typecheck`: PASS
- focused Step 2 tests: 39/39 PASS
- `npm test`: 74/74 PASS
- `git diff --check`: PASS
