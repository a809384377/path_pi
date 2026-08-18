import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

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

export class JsonSessionStore {
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
    const value = JSON.parse(content) as unknown;
    return validateManifest(value);
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

export function validateManifest(value: unknown): SessionManifest {
  if (!isRecord(value) || value.version !== 1 || typeof value.cleanShutdown !== "boolean" || !isRecord(value.sessions)) {
    throw new Error("Invalid pi-agent-mcp session manifest");
  }

  const validSessionStates = new Set<StoredSessionState>(["dormant", "idle", "running", "error", "closed"]);
  const validTaskStatuses = new Set<StoredTaskStatus>(["completed", "failed", "aborted", "host_interrupted"]);
  for (const [sessionId, sessionValue] of Object.entries(value.sessions)) {
    if (!isRecord(sessionValue)) throw new Error(`Invalid session ${sessionId}`);
    if (
      sessionValue.sessionId !== sessionId ||
      typeof sessionValue.cwd !== "string" ||
      typeof sessionValue.generation !== "number" ||
      !Number.isSafeInteger(sessionValue.generation) ||
      sessionValue.generation < 1
    ) {
      throw new Error(`Invalid session ${sessionId}`);
    }
    if (
      typeof sessionValue.state !== "string" ||
      !validSessionStates.has(sessionValue.state as StoredSessionState) ||
      !(sessionValue.activeTaskId === null || typeof sessionValue.activeTaskId === "string")
    ) {
      throw new Error(`Invalid session state ${sessionId}`);
    }
    if (sessionValue.lastTask !== undefined) {
      const task = sessionValue.lastTask;
      if (
        !isRecord(task) ||
        typeof task.taskId !== "string" ||
        task.sessionId !== sessionId ||
        typeof task.status !== "string" ||
        !validTaskStatuses.has(task.status as StoredTaskStatus) ||
        typeof task.completedAt !== "string"
      ) {
        throw new Error(`Invalid last task for session ${sessionId}`);
      }
    }
  }
  return value as unknown as SessionManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
