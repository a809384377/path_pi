import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { MigrationCandidate, MigrationCandidateLockCoordinator } from "../store/v1-migration.js";
import { assertNoSymlinkComponents, assertPrivateDirectory, ensurePrivateDirectory, syncDirectory } from "../store/secure-fs.js";
import { flockExclusiveNonblocking } from "./flock.js";

export type OwnershipDomain = "migration" | "source" | "logical" | "native";

const domainOrder: Record<OwnershipDomain, number> = { migration: 0, source: 1, logical: 2, native: 3 };
const maxDiagnosticBytes = 4_096;

export interface OwnershipDiagnostic {
  pid?: number;
  sessionId?: string;
  nativeSessionId?: string;
  purpose?: string;
  acquiredAt?: string;
}

export class OwnershipLockHandle {
  readonly domain: OwnershipDomain;
  readonly key: string;
  readonly path: string;
  #file: FileHandle | undefined;

  constructor(domain: OwnershipDomain, key: string, path: string, file: FileHandle) {
    this.domain = domain;
    this.key = key;
    this.path = path;
    this.#file = file;
  }

  get fd(): number {
    if (!this.#file) throw new Error(`ownership_released: ${this.domain}:${this.key}`);
    return this.#file.fd;
  }

  get inheritedFd(): number {
    return this.fd;
  }

  get held(): boolean {
    return this.#file !== undefined;
  }

  async close(): Promise<void> {
    const file = this.#file;
    if (!file) return;
    this.#file = undefined;
    // Never call LOCK_UN: descendants may share this open-file description.
    await file.close();
  }
}

export class SessionOwnership {
  readonly logical: OwnershipLockHandle;
  readonly native: OwnershipLockHandle;
  #closed = false;

  constructor(logical: OwnershipLockHandle, native: OwnershipLockHandle) {
    this.logical = logical;
    this.native = native;
  }

  get inheritedFds(): readonly [number, number] {
    return [this.logical.inheritedFd, this.native.inheritedFd];
  }

  get held(): boolean {
    return !this.#closed && this.logical.held && this.native.held;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    for (const handle of [this.native, this.logical]) {
      try {
        await handle.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Failed to close session ownership descriptors");
  }
}

export class OwnershipLockManager {
  readonly root: string;
  readonly locksDirectory: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error(`unsafe_path: ownership root must be absolute: ${root}`);
    this.root = resolve(root);
    this.locksDirectory = join(this.root, "locks");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.root);
    await ensurePrivateDirectory(this.locksDirectory);
  }

  lockPath(domain: OwnershipDomain, key: string): string {
    if (key.length === 0) throw new Error(`ownership_invalid_key: ${domain}`);
    const digest = createHash("sha256")
      .update(`pi-agent-mcp:ownership:v2:${domain}\0`)
      .update(key)
      .digest("hex");
    return join(this.locksDirectory, `${domain}-${digest}.lock`);
  }

  async acquire(
    domain: OwnershipDomain,
    key: string,
    diagnostic: OwnershipDiagnostic = {},
  ): Promise<OwnershipLockHandle> {
    await this.initialize();
    await assertPrivateDirectory(this.locksDirectory);
    const path = this.lockPath(domain, key);
    await assertNoSymlinkComponents(path, { allowMissing: true });
    let file: FileHandle | undefined;
    try {
      file = await open(
        path,
        constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await validateLockFile(path, file);
      await syncDirectory(this.locksDirectory);
      try {
        await flockExclusiveNonblocking(file.fd);
      } catch (error) {
        if (isContention(error)) throw contentionError(domain, key);
        if (String(error).includes("ownership_unavailable:")) throw error;
        throw new Error(`ownership_unavailable: flock ${domain}:${key}: ${errorMessage(error)}`);
      }
      await writeDiagnostic(file, domain, key, diagnostic);
      return new OwnershipLockHandle(domain, key, path, file);
    } catch (error) {
      await file?.close().catch(() => undefined);
      const message = errorMessage(error);
      if (/^(session_in_use|native_session_in_use|migration_blocked|ownership_unavailable|unsafe_path):/.test(message)) throw error;
      throw new Error(`ownership_unavailable: ${domain}:${key}: ${message}`);
    }
  }

  async acquireSession(
    logicalId: string,
    nativeId: string,
    diagnostic: OwnershipDiagnostic = {},
  ): Promise<SessionOwnership> {
    const logical = await this.acquire("logical", logicalId, { ...diagnostic, sessionId: logicalId });
    try {
      const native = await this.acquire("native", nativeId, {
        ...diagnostic,
        sessionId: logicalId,
        nativeSessionId: nativeId,
      });
      return new SessionOwnership(logical, native);
    } catch (error) {
      await logical.close().catch(() => undefined);
      throw error;
    }
  }
}

export class FlockMigrationCandidateLockCoordinator implements MigrationCandidateLockCoordinator {
  readonly #locks: OwnershipLockManager;

  constructor(locks: OwnershipLockManager) {
    this.#locks = locks;
  }

  async withCandidateLocks<T>(
    candidates: readonly MigrationCandidate[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const ordered = deduplicateAndOrderCandidates(candidates);
    const held: OwnershipLockHandle[] = [];
    try {
      for (const candidate of ordered) {
        held.push(await this.#locks.acquire(candidate.kind, candidate.key, { purpose: "v1-migration" }));
      }
      return await operation();
    } finally {
      const failures: unknown[] = [];
      for (const handle of held.reverse()) {
        try {
          await handle.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Failed to close migration ownership descriptors");
    }
  }
}

export function deduplicateAndOrderCandidates(candidates: readonly MigrationCandidate[]): MigrationCandidate[] {
  const unique = new Map<string, MigrationCandidate>();
  for (const candidate of candidates) unique.set(`${candidate.kind}\0${candidate.key}`, candidate);
  return [...unique.values()].sort((left, right) =>
    domainOrder[left.kind] - domainOrder[right.kind] || left.key.localeCompare(right.key),
  );
}

async function validateLockFile(path: string, file: FileHandle): Promise<void> {
  const opened = await file.stat({ bigint: true });
  const linked = await lstat(path, { bigint: true });
  if (
    !opened.isFile() ||
    !linked.isFile() ||
    linked.isSymbolicLink() ||
    opened.dev !== linked.dev ||
    opened.ino !== linked.ino
  ) {
    throw new Error(`ownership_unavailable: unsafe lock file identity: ${path}`);
  }
  if ((Number(opened.mode) & 0o777) !== 0o600) {
    throw new Error(`ownership_unavailable: lock file mode must be 0600: ${path}`);
  }
  if (typeof process.geteuid === "function" && Number(opened.uid) !== process.geteuid()) {
    throw new Error(`ownership_unavailable: lock file owner mismatch: ${path}`);
  }
}

async function writeDiagnostic(
  file: FileHandle,
  domain: OwnershipDomain,
  key: string,
  diagnostic: OwnershipDiagnostic,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    domain,
    key,
    pid: diagnostic.pid ?? process.pid,
    acquiredAt: diagnostic.acquiredAt ?? new Date().toISOString(),
    ...(diagnostic.sessionId ? { sessionId: diagnostic.sessionId } : {}),
    ...(diagnostic.nativeSessionId ? { nativeSessionId: diagnostic.nativeSessionId } : {}),
    ...(diagnostic.purpose ? { purpose: diagnostic.purpose } : {}),
  })}\n`);
  if (bytes.length > maxDiagnosticBytes) throw new Error(`ownership_unavailable: diagnostic exceeds ${maxDiagnosticBytes} bytes`);
  await file.truncate(0);
  await file.write(bytes, 0, bytes.length, 0);
  await file.sync();
}

function isContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EAGAIN" || code === "EWOULDBLOCK" || code === "EACCES";
}

function contentionError(domain: OwnershipDomain, key: string): Error {
  if (domain === "native") return new Error(`native_session_in_use: ${key}`);
  if (domain === "logical") return new Error(`session_in_use: ${key}`);
  return new Error(`migration_blocked: ${domain}:${key}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
