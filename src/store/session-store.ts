import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { isAbsolute, basename, join, resolve } from "node:path";
import { assertPrivateDirectory, ensurePrivateDirectory, publishNoReplace, readSecureFile, replaceAtomic } from "./secure-fs.js";
import type { StoredTask, StoredTaskStatus } from "./legacy-session-store.js";

export {
  LegacyJsonSessionStore,
  LegacyJsonSessionStore as JsonSessionStore,
  validateManifest,
  type SessionManifest,
  type StoredSession,
} from "./legacy-session-store.js";
export type { StoredTask, StoredTaskStatus } from "./legacy-session-store.js";

export type SessionRecordState = "creating" | "dormant" | "idle" | "running" | "error" | "closed" | "migration_blocked";

export interface MigrationProvenance {
  migrationId: string;
  sourcePath: string;
  sourceHash: string;
  sourceSessionHash: string;
}

export interface SessionRecordV2 {
  version: 2;
  sessionId: string;
  revision: number;
  generation: number;
  name?: string;
  cwd: string;
  model?: string;
  piSessionId?: string;
  sessionFile?: string;
  state: SessionRecordState;
  recoverable: boolean;
  activeTaskId: string | null;
  lastTask?: StoredTask;
  migration?: MigrationProvenance;
  updatedAt: string;
}

export interface SessionRecordStoreApi {
  create(record: SessionRecordV2): Promise<void>;
  read(sessionId: string): Promise<SessionRecordV2>;
  updateOwned(sessionId: string, expectedRevision: number, next: SessionRecordV2): Promise<void>;
  list(): Promise<SessionRecordV2[]>;
  drain(sessionId?: string): Promise<void>;
}

export class SessionRecordStore implements SessionRecordStoreApi {
  readonly root: string;
  readonly sessionsDirectory: string;
  readonly temporaryDirectory: string;
  readonly #chains = new Map<string, Promise<void>>();

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error(`unsafe_path: state root must be absolute: ${root}`);
    this.root = resolve(root);
    this.sessionsDirectory = join(this.root, "sessions");
    this.temporaryDirectory = join(this.root, "tmp");
  }

  recordPath(sessionId: string): string {
    return join(this.sessionsDirectory, `${sessionRecordHash(sessionId)}.json`);
  }

  create(record: SessionRecordV2): Promise<void> {
    const snapshot = structuredClone(validateSessionRecord(record));
    return this.#enqueue(snapshot.sessionId, () => this.#create(snapshot));
  }

  async read(sessionId: string): Promise<SessionRecordV2> {
    const path = this.recordPath(sessionId);
    let content: string;
    try {
      await assertPrivateDirectory(this.root);
      await assertPrivateDirectory(this.sessionsDirectory);
      content = (await readSecureFile(path)).toString("utf8");
    } catch (error) {
      if (String(error).includes("ENOENT")) throw new Error(`unknown_session: ${sessionId}`);
      throw error;
    }
    return parseRecordFile(path, content, sessionId);
  }

  updateOwned(sessionId: string, expectedRevision: number, next: SessionRecordV2): Promise<void> {
    const snapshot = structuredClone(validateSessionRecord(next));
    if (snapshot.sessionId !== sessionId) throw new Error(`session_id_mismatch: expected ${sessionId}`);
    if (snapshot.revision !== expectedRevision + 1) {
      throw new Error(`revision_invalid: ${sessionId} must advance from ${expectedRevision} to ${expectedRevision + 1}`);
    }
    return this.#enqueue(sessionId, () => this.#update(sessionId, expectedRevision, snapshot));
  }

  async list(): Promise<SessionRecordV2[]> {
    let entries: string[];
    try {
      await assertPrivateDirectory(this.root);
      await assertPrivateDirectory(this.sessionsDirectory);
      entries = await readdir(this.sessionsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const paths = entries.filter((name) => name.endsWith(".json")).sort().map((name) => join(this.sessionsDirectory, name));
    const records: SessionRecordV2[] = [];
    for (const path of paths) {
      records.push(parseRecordFile(path, (await readSecureFile(path)).toString("utf8")));
    }
    return records;
  }

  async drain(sessionId?: string): Promise<void> {
    if (sessionId !== undefined) {
      await (this.#chains.get(sessionId) ?? Promise.resolve());
      return;
    }
    await Promise.all([...this.#chains.values()]);
  }

  async #create(record: SessionRecordV2): Promise<void> {
    await this.#ensureDirectories();
    const finalPath = this.recordPath(record.sessionId);
    try {
      await publishNoReplace(finalPath, serializeRecord(record));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`session_exists: ${record.sessionId}`);
      throw error;
    }
  }

  async #update(sessionId: string, expectedRevision: number, next: SessionRecordV2): Promise<void> {
    await this.#ensureDirectories();
    const current = await this.read(sessionId);
    if (current.revision !== expectedRevision) {
      throw new Error(`revision_conflict: ${sessionId} expected ${expectedRevision}, found ${current.revision}`);
    }
    if (!sameMigrationProvenance(current.migration, next.migration)) {
      throw new Error(`migration_provenance_immutable: ${sessionId}`);
    }
    const finalPath = this.recordPath(sessionId);
    await replaceAtomic(finalPath, serializeRecord(next));
  }

  async #ensureDirectories(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(this.sessionsDirectory);
    await ensurePrivateDirectory(this.temporaryDirectory);
  }

  #enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(sessionId) ?? Promise.resolve();
    const current = previous.then(operation);
    const settled = current.catch(() => undefined);
    this.#chains.set(sessionId, settled);
    void settled.finally(() => {
      if (this.#chains.get(sessionId) === settled) this.#chains.delete(sessionId);
    });
    return current;
  }
}

export function sessionRecordHash(sessionId: string): string {
  return createHash("sha256").update("pi-agent-mcp:session-record:v2\0").update(sessionId).digest("hex");
}

export function validateSessionRecord(value: unknown): SessionRecordV2 {
  if (!isRecord(value) || value.version !== 2 || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("Invalid pi-agent-mcp v2 session record");
  }
  if (!isSafePositiveInteger(value.revision) || !isSafePositiveInteger(value.generation)) {
    throw new Error(`Invalid revision or generation for ${value.sessionId}`);
  }
  if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) throw new Error(`Invalid cwd for ${value.sessionId}`);
  const states = new Set<SessionRecordState>(["creating", "dormant", "idle", "running", "error", "closed", "migration_blocked"]);
  if (typeof value.state !== "string" || !states.has(value.state as SessionRecordState)) {
    throw new Error(`Invalid state for ${value.sessionId}`);
  }
  if (typeof value.recoverable !== "boolean" || !(value.activeTaskId === null || typeof value.activeTaskId === "string")) {
    throw new Error(`Invalid lifecycle for ${value.sessionId}`);
  }
  if (typeof value.updatedAt !== "string") throw new Error(`Invalid updatedAt for ${value.sessionId}`);
  const updatedAt = value.updatedAt;
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`Invalid updatedAt for ${value.sessionId}`);
  }
  for (const key of ["name", "model", "piSessionId", "sessionFile"] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== "string") throw new Error(`Invalid ${key} for ${value.sessionId}`);
  }
  const sessionFile = value.sessionFile;
  if (sessionFile !== undefined && (typeof sessionFile !== "string" || !isAbsolute(sessionFile))) {
    throw new Error(`Invalid sessionFile for ${value.sessionId}`);
  }
  if (value.recoverable && (typeof value.piSessionId !== "string" || typeof value.sessionFile !== "string")) {
    throw new Error(`Recoverable session ${value.sessionId} lacks Pi identity`);
  }
  if (value.lastTask !== undefined) validateStoredTask(value.lastTask, value.sessionId);
  if (value.migration !== undefined) validateMigration(value.migration, value.sessionId);
  return value as unknown as SessionRecordV2;
}

export function recordsHaveSameImmutableIdentity(left: SessionRecordV2, right: SessionRecordV2): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.piSessionId === right.piSessionId &&
    left.sessionFile === right.sessionFile &&
    sameMigrationProvenance(left.migration, right.migration)
  );
}

function parseRecordFile(path: string, content: string, expectedSessionId?: string): SessionRecordV2 {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`Invalid session record ${path}: ${errorMessage(error)}`);
  }
  let record: SessionRecordV2;
  try {
    record = validateSessionRecord(value);
  } catch (error) {
    throw new Error(`Invalid session record ${path}: ${errorMessage(error)}`);
  }
  if (expectedSessionId !== undefined && record.sessionId !== expectedSessionId) {
    throw new Error(`Invalid session record ${path}: session id mismatch`);
  }
  const actualName = basename(path);
  const expectedName = `${sessionRecordHash(record.sessionId)}.json`;
  if (actualName !== expectedName) throw new Error(`Invalid session record ${path}: filename hash mismatch`);
  return record;
}

function serializeRecord(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function validateStoredTask(value: unknown, sessionId: string): asserts value is StoredTask {
  const statuses = new Set<StoredTaskStatus>(["completed", "failed", "aborted", "host_interrupted"]);
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0 ||
    value.sessionId !== sessionId ||
    typeof value.status !== "string" ||
    !statuses.has(value.status as StoredTaskStatus) ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.completedAt))
  ) {
    throw new Error(`Invalid last task for ${sessionId}`);
  }
  if (value.response !== undefined && typeof value.response !== "string") throw new Error(`Invalid task response for ${sessionId}`);
  if (value.error !== undefined && typeof value.error !== "string") throw new Error(`Invalid task error for ${sessionId}`);
}

function validateMigration(value: unknown, sessionId: string): asserts value is MigrationProvenance {
  if (!isRecord(value)) throw new Error(`Invalid migration provenance for ${sessionId}`);
  for (const key of ["migrationId", "sourcePath", "sourceHash", "sourceSessionHash"] as const) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) throw new Error(`Invalid migration provenance for ${sessionId}`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.migrationId)) || !/^[a-f0-9]{64}$/.test(String(value.sourceHash)) || !/^[a-f0-9]{64}$/.test(String(value.sourceSessionHash))) {
    throw new Error(`Invalid migration provenance hash for ${sessionId}`);
  }
  const sourcePath = value.sourcePath;
  if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) throw new Error(`Invalid migration source path for ${sessionId}`);
}

function sameMigrationProvenance(left: MigrationProvenance | undefined, right: MigrationProvenance | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.migrationId === right.migrationId &&
    left.sourcePath === right.sourcePath &&
    left.sourceHash === right.sourceHash &&
    left.sourceSessionHash === right.sourceSessionHash
  );
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
