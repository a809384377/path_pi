import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, readdir, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  SessionRecordStore,
  recordsHaveSameImmutableIdentity,
  validateSessionRecord,
  type SessionRecordV2,
  type StoredTask,
} from "./session-store.js";
import { readPiSessionIdentity, type PiSessionIdentity } from "./pi-session-header.js";
import { validateManifest, type SessionManifest, type StoredSession } from "./legacy-session-store.js";
import {
  assertNoSymlinkComponents,
  assertPrivateDirectory,
  ensurePrivateDirectory,
  publishNoReplace,
  readSecureFile,
  replaceAtomic,
  syncDirectory,
} from "./secure-fs.js";

export type MigrationCandidate =
  | { kind: "migration"; key: "v1" }
  | { kind: "source"; key: string }
  | { kind: "logical"; key: string }
  | { kind: "native"; key: string };

export interface MigrationCandidateLockCoordinator {
  withCandidateLocks<T>(candidates: readonly MigrationCandidate[], operation: () => Promise<T>): Promise<T>;
}

export class InProcessMigrationCandidateLockCoordinator implements MigrationCandidateLockCoordinator {
  #chain: Promise<void> = Promise.resolve();

  async withCandidateLocks<T>(_candidates: readonly MigrationCandidate[], operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = this.#chain;
    this.#chain = new Promise<void>((resolveTurn) => {
      release = resolveTurn;
    });
    await turn;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export interface V1MigrationHooks {
  afterCandidateLocksAcquired?: () => Promise<void> | void;
  beforeSourceHashRecheck?: () => Promise<void> | void;
  beforeSourceTransition?: (quarantinePath: string) => Promise<void> | void;
  afterSourceRetired?: () => Promise<void> | void;
  afterRecordPublished?: (sessionId: string) => Promise<void> | void;
}

export interface V1SessionMigratorOptions {
  root: string;
  recordStore: SessionRecordStore;
  coordinator?: MigrationCandidateLockCoordinator;
  allowDirty?: boolean;
  now?: () => string;
  hooks?: V1MigrationHooks;
}

export type MigrationOutcome =
  | { status: "migrated" | "resumed" | "already_complete"; migrationId: string; records: number; retiredPath: string }
  | { status: "conflict"; migrationId: string; conflicts: string[] }
  | { status: "source_missing"; sourcePath: string };

interface PiIdentitySnapshot {
  sessionId: string;
  path: string;
  device: string;
  inode: string;
}

interface MigrationIntentV1 {
  version: 1;
  migrationId: string;
  sourcePath: string;
  sourceHash: string;
  quarantinePath: string;
  status: "staged" | "ready_to_retire" | "retired" | "publishing" | "quarantined_mismatch";
  records: SessionRecordV2[];
  recordPayloadHashes: Record<string, string>;
  identitySnapshots: Record<string, PiIdentitySnapshot>;
  publishedSessionIds: string[];
  createdAt: string;
}

interface MigrationReceiptV1 {
  version: 1;
  migrationId: string;
  sourcePath: string;
  sourceHash: string;
  quarantinePath: string;
  recordPayloadHashes: Record<string, string>;
  publishedSessionIds: string[];
  completedAt: string;
}

export class V1SessionMigrator {
  readonly #root: string;
  readonly #store: SessionRecordStore;
  readonly #coordinator: MigrationCandidateLockCoordinator | undefined;
  readonly #allowDirty: boolean;
  readonly #now: () => string;
  readonly #hooks: V1MigrationHooks;

  constructor(options: V1SessionMigratorOptions) {
    if (!isAbsolute(options.root)) throw new Error(`unsafe_path: migration root must be absolute: ${options.root}`);
    this.#root = resolve(options.root);
    this.#store = options.recordStore;
    this.#coordinator = options.coordinator;
    this.#allowDirty = options.allowDirty ?? false;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#hooks = options.hooks ?? {};
  }

  async resumeIncomplete(): Promise<MigrationOutcome[]> {
    this.#requireCoordinator();
    await this.#ensureMigrationRoot();
    const directory = this.#migrationsDirectory();
    const outcomes: MigrationOutcome[] = [];
    for (const entry of (await readdir(directory)).filter((name) => name.startsWith("v1-")).sort()) {
      const transactionDirectory = join(directory, entry);
      await assertPrivateDirectory(transactionDirectory);
      const intentPath = join(transactionDirectory, "intent.json");
      const receiptPath = join(transactionDirectory, "receipt.json");
      if (!(await pathExists(intentPath))) {
        if (await pathExists(receiptPath)) throw new Error(`migration_receipt_without_intent: ${transactionDirectory}`);
        continue;
      }
      if (await pathExists(receiptPath)) {
        await this.#validateCompletedTransaction(transactionDirectory);
        continue;
      }
      outcomes.push(await this.#resume(transactionDirectory));
    }
    return outcomes;
  }

  async migrateSource(sourcePath: string): Promise<MigrationOutcome> {
    this.#requireCoordinator();
    await this.#ensureMigrationRoot();
    const requestedPath = await canonicalizePossiblyMissingPath(sourcePath);
    let canonicalSource: string;
    try {
      canonicalSource = await canonicalizeExistingSource(sourcePath);
    } catch (error) {
      if (!String(error).includes("ENOENT")) throw error;
      const transaction = await this.#findTransactionForSource(requestedPath);
      if (!transaction) return { status: "source_missing", sourcePath };
      if (transaction.completed) return this.#validateCompletedTransaction(transaction.directory);
      return this.#resume(transaction.directory);
    }

    const sourceBytes = await readSecureFile(canonicalSource);
    const sourceHash = hashBytes(sourceBytes);
    const migrationId = migrationIdentifier(canonicalSource, sourceHash);
    const transactionDirectory = this.#transactionDirectory(migrationId);
    if (await pathExists(transactionDirectory)) {
      await assertPrivateDirectory(transactionDirectory);
      if (await pathExists(join(transactionDirectory, "receipt.json"))) {
        return this.#validateCompletedTransaction(transactionDirectory);
      }
      if (await pathExists(join(transactionDirectory, "intent.json"))) return this.#resume(transactionDirectory);
    } else {
      await ensurePrivateDirectory(transactionDirectory);
    }

    const manifest = parseManifest(sourceBytes, canonicalSource);
    if (!manifest.cleanShutdown && !this.#allowDirty) {
      throw new Error(`legacy_state_uncertain: ${canonicalSource}; set PI_AGENT_MCP_IMPORT_DIRTY=1 only after stopping legacy clients`);
    }
    const createdAt = this.#now();
    const converted = await this.#convertManifest(manifest, canonicalSource, sourceHash, migrationId, createdAt);
    const quarantinePath = join(dirname(canonicalSource), `sessions.v1.quarantine-${migrationId}-${randomUUID()}.json`);
    const intent: MigrationIntentV1 = {
      version: 1,
      migrationId,
      sourcePath: canonicalSource,
      sourceHash,
      quarantinePath,
      status: "staged",
      records: converted.records,
      recordPayloadHashes: payloadHashes(converted.records),
      identitySnapshots: converted.identities,
      publishedSessionIds: [],
      createdAt,
    };
    await publishNoReplaceOrExact(join(transactionDirectory, "source.json"), sourceBytes);
    await publishNoReplaceOrExact(join(transactionDirectory, "intent.json"), serializeJson(intent));
    await this.#validateIntentAgainstBackup(intent, sourceBytes);
    return this.#runIntent(transactionDirectory, intent, false);
  }

  async #resume(transactionDirectory: string): Promise<MigrationOutcome> {
    const intent = await this.#readIntent(transactionDirectory);
    const backup = await readSecureFile(join(transactionDirectory, "source.json"));
    await this.#validateIntentAgainstBackup(intent, backup);
    return this.#runIntent(transactionDirectory, intent, true);
  }

  async #runIntent(transactionDirectory: string, intent: MigrationIntentV1, resumed: boolean): Promise<MigrationOutcome> {
    const backup = await readSecureFile(join(transactionDirectory, "source.json"));
    await this.#validateIntentAgainstBackup(intent, backup);
    return this.#requireCoordinator().withCandidateLocks(orderedMigrationCandidates(intent.sourcePath, intent.records), async () => {
      if (await pathExists(join(transactionDirectory, "receipt.json"))) {
        return this.#validateCompletedTransaction(transactionDirectory);
      }
      if (intent.status === "quarantined_mismatch") {
        await assertFileHash(intent.quarantinePath, undefined, "migration_quarantined_mismatch");
        throw new Error(`migration_quarantined_mismatch: ${intent.quarantinePath}`);
      }

      await this.#hooks.afterCandidateLocksAcquired?.();
      await this.#revalidateImportedIdentities(intent);
      if (intent.status === "staged" || intent.status === "ready_to_retire") {
        const conflicts = await this.#preflight(intent.records);
        if (conflicts.length > 0) {
          await publishNoReplaceOrExact(
            join(transactionDirectory, "conflicts.json"),
            serializeJson({ version: 1, migrationId: intent.migrationId, conflicts }),
          );
          return { status: "conflict" as const, migrationId: intent.migrationId, conflicts };
        }
      }

      if (intent.status === "staged" || intent.status === "ready_to_retire") {
        await this.#hooks.beforeSourceHashRecheck?.();
        let sourcePresent = await pathExists(intent.sourcePath);
        if (sourcePresent) {
          const liveBytes = await readSecureFile(intent.sourcePath);
          if (hashBytes(liveBytes) !== intent.sourceHash) throw new Error(`migration_source_changed: ${intent.sourcePath}`);
          intent.status = "ready_to_retire";
          await replaceAtomic(join(transactionDirectory, "intent.json"), serializeJson(intent));
          await this.#hooks.beforeSourceTransition?.(intent.quarantinePath);
          await transitionToUniqueQuarantine(intent.sourcePath, intent.quarantinePath);
          const transitionedHash = hashBytes(await readSecureFile(intent.quarantinePath));
          sourcePresent = await pathExists(intent.sourcePath);
          if (transitionedHash !== intent.sourceHash || sourcePresent) {
            intent.status = "quarantined_mismatch";
            await replaceAtomic(join(transactionDirectory, "intent.json"), serializeJson(intent));
            throw new Error(
              transitionedHash !== intent.sourceHash
                ? `migration_quarantined_mismatch: ${intent.quarantinePath}`
                : `migration_source_reappeared: ${intent.sourcePath}`,
            );
          }
          intent.status = "retired";
          await replaceAtomic(join(transactionDirectory, "intent.json"), serializeJson(intent));
          await this.#hooks.afterSourceRetired?.();
        } else {
          const transitionedHash = hashBytes(await readSecureFile(intent.quarantinePath));
          if (transitionedHash !== intent.sourceHash) {
            intent.status = "quarantined_mismatch";
            await replaceAtomic(join(transactionDirectory, "intent.json"), serializeJson(intent));
            throw new Error(`migration_quarantined_mismatch: ${intent.quarantinePath}`);
          }
          intent.status = "retired";
          await replaceAtomic(join(transactionDirectory, "intent.json"), serializeJson(intent));
        }
      } else {
        await assertFileHash(intent.quarantinePath, intent.sourceHash, "migration_quarantine_hash_mismatch");
        if (await pathExists(intent.sourcePath)) throw new Error(`migration_source_reappeared: ${intent.sourcePath}`);
      }

      intent.status = "publishing";
      await replaceAtomic(join(transactionDirectory, "intent.json"), serializeJson(intent));
      for (const staged of intent.records) {
        if (intent.publishedSessionIds.includes(staged.sessionId)) {
          await this.#assertAcceptedExisting(staged);
          continue;
        }
        let existing: SessionRecordV2 | undefined;
        try {
          existing = await this.#store.read(staged.sessionId);
        } catch (error) {
          if (!String(error).includes("unknown_session")) throw error;
        }
        if (existing) assertMigrationDescendant(staged, existing);
        else await this.#store.create(staged);
        intent.publishedSessionIds.push(staged.sessionId);
        await replaceAtomic(join(transactionDirectory, "intent.json"), serializeJson(intent));
        await this.#hooks.afterRecordPublished?.(staged.sessionId);
      }

      const receipt: MigrationReceiptV1 = {
        version: 1,
        migrationId: intent.migrationId,
        sourcePath: intent.sourcePath,
        sourceHash: intent.sourceHash,
        quarantinePath: intent.quarantinePath,
        recordPayloadHashes: { ...intent.recordPayloadHashes },
        publishedSessionIds: intent.records.map((record) => record.sessionId),
        completedAt: this.#now(),
      };
      await publishNoReplace(join(transactionDirectory, "receipt.json"), serializeJson(receipt));
      return this.#validateCompletedTransaction(transactionDirectory, resumed ? "resumed" : "migrated");
    });
  }

  async #validateCompletedTransaction(
    transactionDirectory: string,
    successStatus: "migrated" | "resumed" | "already_complete" = "already_complete",
  ): Promise<MigrationOutcome> {
    await assertPrivateDirectory(transactionDirectory);
    const intent = await this.#readIntent(transactionDirectory);
    const backup = await readSecureFile(join(transactionDirectory, "source.json"));
    await this.#validateIntentAgainstBackup(intent, backup);
    const receipt = validateReceipt(
      parseJson(await readSecureFile(join(transactionDirectory, "receipt.json")), "migration_receipt_invalid"),
      transactionDirectory,
    );
    const expectedIds = intent.records.map((record) => record.sessionId);
    if (
      receipt.migrationId !== intent.migrationId ||
      receipt.sourcePath !== intent.sourcePath ||
      receipt.sourceHash !== intent.sourceHash ||
      receipt.quarantinePath !== intent.quarantinePath ||
      !isDeepStrictEqual(receipt.recordPayloadHashes, intent.recordPayloadHashes) ||
      !isDeepStrictEqual(receipt.publishedSessionIds, expectedIds) ||
      !isDeepStrictEqual(intent.publishedSessionIds, expectedIds)
    ) {
      throw new Error(`migration_receipt_incomplete: ${intent.migrationId}`);
    }
    await assertFileHash(intent.quarantinePath, intent.sourceHash, "migration_quarantine_hash_mismatch");
    if (await pathExists(intent.sourcePath)) throw new Error(`migration_source_reappeared: ${intent.sourcePath}`);
    for (const staged of intent.records) await this.#assertAcceptedExisting(staged);
    return {
      status: successStatus,
      migrationId: intent.migrationId,
      records: intent.records.length,
      retiredPath: intent.quarantinePath,
    };
  }

  async #validateIntentAgainstBackup(intent: MigrationIntentV1, backup: Buffer): Promise<void> {
    if (hashBytes(backup) !== intent.sourceHash) throw new Error(`migration_backup_mismatch: ${intent.migrationId}`);
    const manifest = parseManifest(backup, intent.sourcePath);
    const expected = this.#convertManifestSnapshot(manifest, intent.sourcePath, intent.sourceHash, intent.migrationId, intent.createdAt);
    if (!isDeepStrictEqual(expected, intent.records)) throw new Error(`migration_staged_payload_mismatch: ${intent.migrationId}`);
    if (!isDeepStrictEqual(payloadHashes(expected), intent.recordPayloadHashes)) {
      throw new Error(`migration_staged_hash_mismatch: ${intent.migrationId}`);
    }
    const identityRecordIds = expected.filter((record) => record.sessionFile).map((record) => record.sessionId).sort();
    if (!isDeepStrictEqual(Object.keys(intent.identitySnapshots).sort(), identityRecordIds)) {
      throw new Error(`migration_identity_snapshot_invalid: ${intent.migrationId}`);
    }
    for (const record of expected) {
      if (!record.sessionFile) continue;
      const snapshot = intent.identitySnapshots[record.sessionId];
      if (
        !snapshot ||
        snapshot.sessionId !== record.piSessionId ||
        snapshot.path !== record.sessionFile ||
        !/^\d+$/.test(snapshot.device) ||
        !/^\d+$/.test(snapshot.inode)
      ) {
        throw new Error(`migration_identity_snapshot_invalid: ${intent.migrationId}`);
      }
    }
    for (const record of intent.records) validateSessionRecord(record);
  }

  async #revalidateImportedIdentities(intent: MigrationIntentV1): Promise<void> {
    for (const record of intent.records) {
      const snapshot = intent.identitySnapshots[record.sessionId];
      if (!snapshot) {
        if (record.sessionFile) throw new Error(`migration_identity_snapshot_missing: ${record.sessionId}`);
        continue;
      }
      const identity = await readPiSessionIdentity(snapshot.path);
      if (
        identity.sessionId !== snapshot.sessionId ||
        identity.sessionId !== record.piSessionId ||
        identity.device.toString() !== snapshot.device ||
        identity.inode.toString() !== snapshot.inode
      ) {
        throw new Error(`migration_pi_identity_changed: ${record.sessionId}`);
      }
    }
  }

  async #preflight(stagedRecords: readonly SessionRecordV2[]): Promise<string[]> {
    const conflicts: string[] = [];
    const nativeOwners = new Map<string, string>();
    for (const staged of stagedRecords) {
      if (!staged.piSessionId) continue;
      const owner = nativeOwners.get(staged.piSessionId);
      if (owner && owner !== staged.sessionId) conflicts.push(`native session ${staged.piSessionId} appears in ${owner} and ${staged.sessionId}`);
      nativeOwners.set(staged.piSessionId, staged.sessionId);
    }
    for (const existing of await this.#store.list()) {
      const staged = stagedRecords.find((candidate) => candidate.sessionId === existing.sessionId);
      if (staged && !isAcceptedMigrationDescendant(staged, existing)) {
        conflicts.push(`logical session ${existing.sessionId} already exists with different content`);
      }
      let actualNative = existing.piSessionId;
      if (existing.sessionFile) {
        if (!existing.piSessionId) throw new Error(`existing_record_identity_invalid: ${existing.sessionId}`);
        const identity = await readPiSessionIdentity(existing.sessionFile);
        if (identity.sessionId !== existing.piSessionId) throw new Error(`existing_record_identity_mismatch: ${existing.sessionId}`);
        actualNative = identity.sessionId;
      } else if (existing.recoverable) {
        throw new Error(`existing_record_identity_invalid: ${existing.sessionId}`);
      }
      if (actualNative) {
        const owner = nativeOwners.get(actualNative);
        if (owner && owner !== existing.sessionId) conflicts.push(`native session ${actualNative} already belongs to ${existing.sessionId}`);
      }
    }
    return [...new Set(conflicts)].sort();
  }

  async #convertManifest(
    manifest: SessionManifest,
    sourcePath: string,
    sourceHash: string,
    migrationId: string,
    createdAt: string,
  ): Promise<{ records: SessionRecordV2[]; identities: Record<string, PiIdentitySnapshot> }> {
    const records = this.#convertManifestSnapshot(manifest, sourcePath, sourceHash, migrationId, createdAt);
    const identities: Record<string, PiIdentitySnapshot> = {};
    for (const record of records) {
      if (!record.sessionFile || !record.piSessionId) continue;
      const identity = await readPiSessionIdentity(record.sessionFile);
      if (identity.sessionId !== record.piSessionId) throw new Error(`migration_pi_identity_mismatch: ${record.sessionId}`);
      identities[record.sessionId] = identitySnapshot(identity);
    }
    return { records, identities };
  }

  #convertManifestSnapshot(
    manifest: SessionManifest,
    sourcePath: string,
    sourceHash: string,
    migrationId: string,
    createdAt: string,
  ): SessionRecordV2[] {
    return Object.keys(manifest.sessions).sort().map((sessionId) =>
      convertSessionSnapshot(manifest.sessions[sessionId]!, sourcePath, sourceHash, migrationId, createdAt),
    );
  }

  async #assertAcceptedExisting(staged: SessionRecordV2): Promise<void> {
    const existing = await this.#store.read(staged.sessionId);
    assertMigrationDescendant(staged, existing);
    if (existing.sessionFile) {
      if (!existing.piSessionId) throw new Error(`existing_record_identity_invalid: ${existing.sessionId}`);
      const identity = await readPiSessionIdentity(existing.sessionFile);
      if (identity.sessionId !== existing.piSessionId) throw new Error(`existing_record_identity_mismatch: ${existing.sessionId}`);
    } else if (existing.recoverable) {
      throw new Error(`existing_record_identity_invalid: ${existing.sessionId}`);
    }
  }

  async #readIntent(transactionDirectory: string): Promise<MigrationIntentV1> {
    return validateIntent(
      parseJson(await readSecureFile(join(transactionDirectory, "intent.json")), "migration_intent_invalid"),
      transactionDirectory,
    );
  }

  async #findTransactionForSource(sourcePath: string): Promise<{ directory: string; completed: boolean } | undefined> {
    const migrationsDirectory = this.#migrationsDirectory();
    for (const entry of (await readdir(migrationsDirectory)).filter((name) => name.startsWith("v1-")).sort()) {
      const directory = join(migrationsDirectory, entry);
      await assertPrivateDirectory(directory);
      const intentPath = join(directory, "intent.json");
      if (!(await pathExists(intentPath))) continue;
      const intent = await this.#readIntent(directory);
      if (resolve(intent.sourcePath) !== sourcePath) continue;
      const completed = await pathExists(join(directory, "receipt.json"));
      if (completed) await this.#validateCompletedTransaction(directory);
      return { directory, completed };
    }
    return undefined;
  }

  async #ensureMigrationRoot(): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(this.#migrationsDirectory());
  }

  #migrationsDirectory(): string {
    return join(this.#root, "migrations");
  }

  #transactionDirectory(migrationId: string): string {
    return join(this.#migrationsDirectory(), `v1-${migrationId}`);
  }

  #requireCoordinator(): MigrationCandidateLockCoordinator {
    if (!this.#coordinator) throw new Error("ownership_unavailable: v1 migration requires a candidate-lock coordinator");
    return this.#coordinator;
  }
}

export function canonicalDefaultStateRoot(home = homedir()): string {
  return join(home, ".pi", "agent-mcp");
}

export function automaticMigrationEnabled(root: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  const canonical = canonicalDefaultStateRoot(home);
  if (env.PI_AGENT_MCP_STATE_DIR !== undefined || resolve(root) !== resolve(canonical)) return false;
  for (const path of [join(home, ".pi"), canonical]) {
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if (path === canonical && ((info.mode & 0o077) !== 0 || (typeof process.geteuid === "function" && info.uid !== process.geteuid()))) return false;
  }
  return true;
}

export function discoverLegacySources(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const explicit = (env.PI_AGENT_MCP_LEGACY_STATE_DIRS ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  const roots = [canonicalDefaultStateRoot(home), join(home, ".pi", "agent-mcp-claude"), join(home, ".pi", "agent-mcp-codex"), ...explicit];
  return [...new Set(roots.map((root) => join(resolve(root), "sessions.json")))];
}

export function migrationIdentifier(sourcePath: string, sourceHash: string): string {
  return createHash("sha256").update(resolve(sourcePath)).update("\0").update(sourceHash).digest("hex");
}

export function orderedMigrationCandidates(sourcePath: string, records: readonly SessionRecordV2[]): MigrationCandidate[] {
  const logical = records.map((record) => ({ kind: "logical" as const, key: record.sessionId })).sort(compareCandidateKey);
  const native = records.filter((record) => record.piSessionId).map((record) => ({ kind: "native" as const, key: record.piSessionId! })).sort(compareCandidateKey);
  return [{ kind: "migration", key: "v1" }, { kind: "source", key: sourcePath }, ...logical, ...native];
}

function compareCandidateKey(left: { key: string }, right: { key: string }): number {
  return left.key.localeCompare(right.key);
}

function convertSessionSnapshot(
  session: StoredSession,
  sourcePath: string,
  sourceHash: string,
  migrationId: string,
  createdAt: string,
): SessionRecordV2 {
  if (session.sessionFile && !session.piSessionId) throw new Error(`migration_pi_identity_missing: ${session.sessionId}`);
  const hadActiveTask = session.activeTaskId !== null || session.state === "running";
  const interruption: StoredTask | undefined = hadActiveTask
    ? {
        taskId: session.activeTaskId ?? `task_interrupted_${session.sessionId}_${session.generation}`,
        sessionId: session.sessionId,
        status: "host_interrupted",
        error: "Previous MCP host stopped before the task completed",
        completedAt: createdAt,
      }
    : undefined;
  const isClosed = session.state === "closed";
  const recoverable = !isClosed && Boolean(session.sessionFile && session.piSessionId);
  return validateSessionRecord({
    version: 2,
    sessionId: session.sessionId,
    revision: 1,
    generation: session.generation,
    ...(session.name ? { name: session.name } : {}),
    cwd: session.cwd,
    ...(session.model ? { model: session.model } : {}),
    ...(session.piSessionId ? { piSessionId: session.piSessionId } : {}),
    ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    state: isClosed ? "closed" : recoverable ? "dormant" : "error",
    recoverable,
    activeTaskId: null,
    ...(interruption ? { lastTask: interruption } : session.lastTask ? { lastTask: session.lastTask } : {}),
    migration: {
      migrationId,
      sourcePath,
      sourceHash,
      sourceSessionHash: hashBytes(Buffer.from(JSON.stringify(session))),
    },
    updatedAt: createdAt,
  });
}

function identitySnapshot(identity: PiSessionIdentity): PiIdentitySnapshot {
  return { sessionId: identity.sessionId, path: identity.path, device: identity.device.toString(), inode: identity.inode.toString() };
}

function payloadHashes(records: readonly SessionRecordV2[]): Record<string, string> {
  return Object.fromEntries(records.map((record) => [record.sessionId, hashBytes(serializeJson(record))]));
}

function assertMigrationDescendant(staged: SessionRecordV2, existing: SessionRecordV2): void {
  if (!isAcceptedMigrationDescendant(staged, existing)) throw new Error(`migration_destination_conflict: ${staged.sessionId}`);
}

function isAcceptedMigrationDescendant(staged: SessionRecordV2, existing: SessionRecordV2): boolean {
  if (existing.revision < staged.revision) return false;
  if (existing.revision === staged.revision) return isDeepStrictEqual(staged, existing);
  return recordsHaveSameImmutableIdentity(staged, existing);
}

function validateIntent(value: unknown, transactionDirectory: string): MigrationIntentV1 {
  if (!isRecord(value) || value.version !== 1 || typeof value.migrationId !== "string" || typeof value.sourcePath !== "string" || typeof value.sourceHash !== "string" || typeof value.quarantinePath !== "string") {
    throw new Error("migration_intent_invalid");
  }
  if (!isHash(value.sourceHash) || migrationIdentifier(value.sourcePath, value.sourceHash) !== value.migrationId || basename(transactionDirectory) !== `v1-${value.migrationId}` || !isAbsolute(value.sourcePath) || !isAbsolute(value.quarantinePath)) {
    throw new Error(`migration_intent_invalid: ${value.migrationId}`);
  }
  if (dirname(value.quarantinePath) !== dirname(value.sourcePath) || !basename(value.quarantinePath).startsWith(`sessions.v1.quarantine-${value.migrationId}-`)) throw new Error(`migration_intent_invalid: ${value.migrationId}`);
  if (!Array.isArray(value.records) || !isRecord(value.recordPayloadHashes) || !isRecord(value.identitySnapshots) || !Array.isArray(value.publishedSessionIds) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) throw new Error(`migration_intent_invalid: ${value.migrationId}`);
  if (!["staged", "ready_to_retire", "retired", "publishing", "quarantined_mismatch"].includes(String(value.status))) throw new Error(`migration_intent_invalid: ${value.migrationId}`);
  const records = value.records.map(validateSessionRecord);
  const ids = records.map((record) => record.sessionId);
  if (new Set(ids).size !== ids.length || !value.publishedSessionIds.every((id) => typeof id === "string" && ids.includes(id)) || new Set(value.publishedSessionIds).size !== value.publishedSessionIds.length) throw new Error(`migration_intent_invalid: ${value.migrationId}`);
  for (const record of records) {
    if (record.migration?.migrationId !== value.migrationId || record.migration.sourcePath !== value.sourcePath || record.migration.sourceHash !== value.sourceHash || typeof value.recordPayloadHashes[record.sessionId] !== "string" || !isHash(String(value.recordPayloadHashes[record.sessionId]))) throw new Error(`migration_intent_invalid: ${value.migrationId}`);
  }
  if (Object.keys(value.recordPayloadHashes).sort().join("\0") !== [...ids].sort().join("\0")) throw new Error(`migration_intent_invalid: ${value.migrationId}`);
  return { ...value, records } as unknown as MigrationIntentV1;
}

function validateReceipt(value: unknown, transactionDirectory: string): MigrationReceiptV1 {
  if (!isRecord(value) || value.version !== 1 || typeof value.migrationId !== "string" || typeof value.sourcePath !== "string" || typeof value.sourceHash !== "string" || typeof value.quarantinePath !== "string" || !isRecord(value.recordPayloadHashes) || !Array.isArray(value.publishedSessionIds) || !value.publishedSessionIds.every((id) => typeof id === "string") || typeof value.completedAt !== "string") throw new Error("migration_receipt_invalid");
  if (basename(transactionDirectory) !== `v1-${value.migrationId}` || !isHash(value.sourceHash) || migrationIdentifier(value.sourcePath, value.sourceHash) !== value.migrationId || !Number.isFinite(Date.parse(value.completedAt)) || new Set(value.publishedSessionIds).size !== value.publishedSessionIds.length) throw new Error(`migration_receipt_invalid: ${value.migrationId}`);
  return value as unknown as MigrationReceiptV1;
}

async function canonicalizeExistingSource(path: string): Promise<string> {
  const absolute = resolve(path);
  await assertNoSymlinkComponents(absolute);
  const parentInfo = await lstat(dirname(absolute));
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error(`unsafe_source_parent: ${dirname(absolute)}`);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`unsafe_source: ${absolute}`);
  return join(await realpath(dirname(absolute)), basename(absolute));
}

async function canonicalizePossiblyMissingPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await canonicalizeExistingSource(absolute);
  } catch (error) {
    if (!String(error).includes("ENOENT")) throw error;
    await assertNoSymlinkComponents(dirname(absolute));
    return join(await realpath(dirname(absolute)), basename(absolute));
  }
}

async function transitionToUniqueQuarantine(sourcePath: string, quarantinePath: string): Promise<void> {
  if (await pathExists(quarantinePath)) throw new Error(`migration_quarantine_exists: ${quarantinePath}`);
  await rename(sourcePath, quarantinePath);
  await syncDirectory(dirname(sourcePath));
}

async function publishNoReplaceOrExact(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await publishNoReplace(path, bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readSecureFile(path)).equals(Buffer.from(bytes))) throw new Error(`migration_artifact_conflict: ${path}`);
  }
}

async function assertFileHash(path: string, expectedHash: string | undefined, code: string): Promise<void> {
  const actual = hashBytes(await readSecureFile(path));
  if (expectedHash === undefined || actual !== expectedHash) throw new Error(`${code}: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseManifest(bytes: Buffer, path: string): SessionManifest {
  try {
    return validateManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch (error) {
    throw new Error(`migration_manifest_invalid: ${path}: ${errorMessage(error)}`);
  }
}

function parseJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${code}: ${errorMessage(error)}`);
  }
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isHash(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
