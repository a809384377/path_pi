import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

export type StoredSessionState = "dormant" | "idle" | "running" | "error" | "closed";
export type StoredTaskStatus = "completed" | "failed" | "aborted" | "host_interrupted";

export interface StoredTask {
  taskId: string;
  sessionId: string;
  status: StoredTaskStatus;
  response?: string;
  error?: string;
  completedAt: string;
}

export interface StoredSession {
  sessionId: string;
  generation: number;
  name?: string;
  cwd: string;
  model?: string;
  piSessionId?: string;
  sessionFile?: string;
  state: StoredSessionState;
  activeTaskId: string | null;
  lastTask?: StoredTask;
}

export interface SessionManifest {
  version: 1;
  cleanShutdown: boolean;
  sessions: Record<string, StoredSession>;
}

const emptyManifest = (): SessionManifest => ({ version: 1, cleanShutdown: true, sessions: {} });

export class LegacyJsonSessionStore {
  readonly #path: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<SessionManifest> {
    let content: string;
    try {
      content = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyManifest();
      throw error;
    }
    return validateManifest(JSON.parse(content) as unknown);
  }

  save(manifest: SessionManifest): Promise<void> {
    const snapshot = structuredClone(manifest);
    const write = this.#writeChain.then(() => this.#writeAtomic(snapshot));
    this.#writeChain = write.catch(() => undefined);
    return write;
  }

  async #writeAtomic(manifest: SessionManifest): Promise<void> {
    validateManifest(manifest);
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

export { LegacyJsonSessionStore as JsonSessionStore };

export function validateManifest(value: unknown): SessionManifest {
  if (!isRecord(value) || value.version !== 1 || typeof value.cleanShutdown !== "boolean" || !isRecord(value.sessions)) {
    throw new Error("Invalid pi-agent-mcp session manifest");
  }

  const validSessionStates = new Set<StoredSessionState>(["dormant", "idle", "running", "error", "closed"]);
  for (const [sessionId, sessionValue] of Object.entries(value.sessions)) {
    if (!isRecord(sessionValue)) throw new Error(`Invalid session ${sessionId}`);
    if (
      sessionValue.sessionId !== sessionId ||
      typeof sessionValue.cwd !== "string" ||
      !isAbsolute(sessionValue.cwd) ||
      typeof sessionValue.generation !== "number" ||
      !Number.isSafeInteger(sessionValue.generation) ||
      sessionValue.generation < 1
    ) {
      throw new Error(`Invalid session ${sessionId}`);
    }
    if (
      typeof sessionValue.state !== "string" ||
      !validSessionStates.has(sessionValue.state as StoredSessionState) ||
      !(
        sessionValue.activeTaskId === null ||
        (typeof sessionValue.activeTaskId === "string" && sessionValue.activeTaskId.length > 0)
      )
    ) {
      throw new Error(`Invalid session state ${sessionId}`);
    }
    for (const key of ["name", "model", "piSessionId", "sessionFile"] as const) {
      const field = sessionValue[key];
      if (field !== undefined && typeof field !== "string") throw new Error(`Invalid ${key} for session ${sessionId}`);
    }
    const sessionFile = sessionValue.sessionFile;
    if (sessionFile !== undefined && (typeof sessionFile !== "string" || !isAbsolute(sessionFile))) {
      throw new Error(`Invalid sessionFile for session ${sessionId}`);
    }
    if (sessionValue.lastTask !== undefined) validateStoredTask(sessionValue.lastTask, sessionId);
  }
  return value as unknown as SessionManifest;
}

function validateStoredTask(value: unknown, sessionId: string): asserts value is StoredTask {
  const validTaskStatuses = new Set<StoredTaskStatus>(["completed", "failed", "aborted", "host_interrupted"]);
  if (
    !isRecord(value) ||
    typeof value.taskId !== "string" ||
    value.taskId.length === 0 ||
    value.sessionId !== sessionId ||
    typeof value.status !== "string" ||
    !validTaskStatuses.has(value.status as StoredTaskStatus) ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    (value.response !== undefined && typeof value.response !== "string") ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new Error(`Invalid last task for session ${sessionId}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
