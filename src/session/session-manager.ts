import { EventEmitter } from "node:events";
import { access, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PiRpcProcess, type PiRpcProcessOptions } from "../rpc/pi-rpc-process.js";
import type { RpcEvent } from "../rpc/types.js";
import {
  JsonSessionStore,
  type SessionManifest,
  type StoredSession,
  type StoredTask,
  type StoredTaskStatus,
} from "../store/session-store.js";

export type SessionState = "dormant" | "restoring" | "dispatching" | "running" | "idle" | "error" | "closing" | "closed";
export type TaskStatus = "dispatching" | "running" | StoredTaskStatus;

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  status: TaskStatus;
  response?: string;
  error?: string;
  completedAt?: string;
}

interface SessionRecord {
  sessionId: string;
  generation: number;
  name?: string;
  cwd: string;
  model?: string;
  piSessionId?: string;
  sessionFile?: string;
  state: SessionState;
  activeTaskId: string | null;
  lastTask?: TaskRecord;
  process: PiRpcProcess | undefined;
  recoverable: boolean;
}

export interface SessionManagerOptions {
  store: JsonSessionStore;
  executable?: string;
  maxSessions?: number;
  commandTimeoutMs?: number;
  shutdownGraceMs?: number;
  rpcFactory?: (options: PiRpcProcessOptions) => PiRpcProcess;
  idFactory?: () => string;
  logger?: (message: string) => void;
}

export interface SpawnInput {
  task: string;
  cwd: string;
  name?: string;
  model?: string;
}

export interface DispatchResult {
  session_id: string;
  task_id: string;
  status: "running";
}

export interface WaitResult {
  completed: TaskResult[];
  pending: string[];
  timed_out: boolean;
}

export interface TaskResult {
  session_id: string;
  task_id: string;
  status: StoredTaskStatus;
  response?: string;
  error?: string;
}

export interface SessionStatus {
  session_id: string;
  name?: string;
  cwd: string;
  model?: string;
  state: SessionState;
  resident: boolean;
  recoverable: boolean;
  current_task_id: string | null;
  last_task?: TaskResult;
  pi_session_id?: string;
  session_file?: string;
}

const terminalStatuses = new Set<TaskStatus>(["completed", "failed", "aborted", "host_interrupted"]);

export class SessionManager extends EventEmitter {
  readonly #options: Required<Pick<SessionManagerOptions, "maxSessions" | "idFactory">> & SessionManagerOptions;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #tasks = new Map<string, TaskRecord>();
  #manifest: SessionManifest = { version: 1, cleanShutdown: true, sessions: {} };
  #shuttingDown = false;

  constructor(options: SessionManagerOptions) {
    super();
    this.#options = {
      ...options,
      maxSessions: options.maxSessions ?? 16,
      idFactory: options.idFactory ?? randomUUID,
    };
  }

  async initialize(): Promise<void> {
    this.#manifest = await this.#options.store.load();
    const wasClean = this.#manifest.cleanShutdown;
    for (const stored of Object.values(this.#manifest.sessions)) {
      const session = this.#fromStoredSession(stored, wasClean);
      this.#sessions.set(session.sessionId, session);
      if (session.lastTask) this.#tasks.set(session.lastTask.taskId, session.lastTask);
    }
    this.#manifest.cleanShutdown = false;
    await this.#persist();
  }

  async spawn(input: SpawnInput): Promise<DispatchResult> {
    this.#assertAvailable();
    const taskText = requireNonEmpty(input.task, "task");
    const cwd = await validateCwd(input.cwd);
    const activeCount = [...this.#sessions.values()].filter((session) => occupiesProcessSlot(session)).length;
    if (activeCount >= this.#options.maxSessions) {
      throw new Error(`session_limit: maximum ${this.#options.maxSessions} active Pi processes reached`);
    }

    const sessionId = `pi_${this.#options.idFactory()}`;
    const taskId = `task_${this.#options.idFactory()}`;
    const task: TaskRecord = { taskId, sessionId, status: "dispatching" };
    const session: SessionRecord = {
      sessionId,
      generation: 1,
      ...(input.name ? { name: input.name } : {}),
      cwd,
      ...(input.model ? { model: input.model } : {}),
      state: "dispatching",
      activeTaskId: taskId,
      recoverable: true,
      process: undefined,
    };
    this.#sessions.set(sessionId, session);
    this.#tasks.set(taskId, task);

    try {
      await this.#persist();
      await this.#startAndDispatch(session, task, taskText, false);
      return { session_id: sessionId, task_id: taskId, status: "running" };
    } catch (error) {
      await this.#failDispatch(session, task, error);
      throw error;
    }
  }

  async send(sessionId: string, taskText: string): Promise<DispatchResult> {
    this.#assertAvailable();
    const session = this.#requireSession(sessionId);
    const text = requireNonEmpty(taskText, "task");
    if (session.state === "closed") throw new Error(`session_closed: ${sessionId}`);
    if (!["idle", "dormant", "error"].includes(session.state)) throw new Error(`session_busy: ${sessionId} is ${session.state}`);
    if (session.state === "error" && !session.recoverable) throw new Error(`session_not_recoverable: ${sessionId}`);
    if (session.activeTaskId !== null) throw new Error(`session_busy: ${sessionId} has an active task`);

    const wasResident = session.state === "idle" && session.process !== undefined;
    if (!wasResident) this.#assertProcessCapacity();
    const taskId = `task_${this.#options.idFactory()}`;
    const task: TaskRecord = { taskId, sessionId, status: "dispatching" };
    session.generation += 1;
    session.activeTaskId = taskId;
    session.state = wasResident ? "dispatching" : "restoring";
    this.#tasks.set(taskId, task);

    try {
      await this.#persist();
      await this.#startAndDispatch(session, task, text, !wasResident);
      return { session_id: sessionId, task_id: taskId, status: "running" };
    } catch (error) {
      await this.#failDispatch(session, task, error);
      throw error;
    }
  }

  async wait(taskIds: readonly string[], mode: "any" | "all" = "any", timeoutMs = 60_000): Promise<WaitResult> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) throw new Error("task_ids must not be empty");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeout must be a non-negative finite number");
    for (const id of ids) {
      if (!this.#tasks.has(id)) throw new Error(`unknown_task: ${id}`);
    }

    const evaluate = (): WaitResult | undefined => {
      const completed = ids.map((id) => this.#tasks.get(id)!).filter(isTerminal);
      const ready = mode === "all" ? completed.length === ids.length : completed.length > 0;
      if (!ready) return undefined;
      const terminalIds = new Set(completed.map((task) => task.taskId));
      return {
        completed: completed.map(toTaskResult),
        pending: ids.filter((id) => !terminalIds.has(id)),
        timed_out: false,
      };
    };

    const immediate = evaluate();
    if (immediate) return immediate;
    if (timeoutMs === 0) return this.#timeoutResult(ids);

    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      const finish = (result: WaitResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("taskTerminal", onTerminal);
        resolve(result);
      };
      const onTerminal = (): void => {
        const result = evaluate();
        if (result) finish(result);
      };
      this.on("taskTerminal", onTerminal);
      const timer = setTimeout(() => finish(this.#timeoutResult(ids)), timeoutMs);
      onTerminal();
    });
  }

  status(sessionId: string): SessionStatus;
  status(): SessionStatus[];
  status(sessionId?: string): SessionStatus | SessionStatus[] {
    if (sessionId) return toSessionStatus(this.#requireSession(sessionId));
    return [...this.#sessions.values()].filter((session) => session.state !== "closed").map(toSessionStatus);
  }

  async close(sessionId: string): Promise<SessionStatus> {
    const session = this.#requireSession(sessionId);
    if (session.state === "closed") return toSessionStatus(session);
    session.state = "closing";
    session.recoverable = false;
    const activeTask = session.activeTaskId ? this.#tasks.get(session.activeTaskId) : undefined;
    if (activeTask && !isTerminal(activeTask)) {
      await this.#finalizeTask(session, activeTask, "aborted", { error: "Session was closed" }, "closing");
    } else {
      await this.#persist();
    }

    const rpc = session.process;
    if (rpc) {
      await rpc.abort().catch(() => undefined);
      await rpc.stop().catch(() => undefined);
      if (session.process === rpc) session.process = undefined;
    }
    session.state = "closed";
    session.activeTaskId = null;
    await this.#persist();
    return toSessionStatus(session);
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const session of this.#sessions.values()) {
      if (session.state === "closed") continue;
      session.state = "closing";
      const task = session.activeTaskId ? this.#tasks.get(session.activeTaskId) : undefined;
      if (task && !isTerminal(task)) {
        await this.#finalizeTask(session, task, "host_interrupted", { error: "MCP host shut down" }, "closing");
      }
      const rpc = session.process;
      if (rpc) {
        await rpc.abort().catch(() => undefined);
        await rpc.stop().catch(() => undefined);
        if (session.process === rpc) session.process = undefined;
      }
      session.state = session.sessionFile ? "dormant" : "error";
      session.recoverable = Boolean(session.sessionFile);
      session.activeTaskId = null;
    }
    this.#manifest.cleanShutdown = true;
    await this.#persist();
  }

  async #startAndDispatch(session: SessionRecord, task: TaskRecord, text: string, restore: boolean): Promise<void> {
    this.#assertDispatchOwned(session, task);
    let rpc = session.process;
    if (!rpc) {
      rpc = this.#createRpc(session);
      session.process = rpc;
      const state = await rpc.start();
      this.#assertDispatchOwned(session, task);
      if (session.process !== rpc) throw new Error("Pi RPC process exited during startup");

      if (restore) {
        if (!session.sessionFile) throw new Error(`session_not_recoverable: ${session.sessionId} has no session file`);
        await access(session.sessionFile);
        this.#assertDispatchOwned(session, task);
        const switched = await rpc.switchSession(session.sessionFile);
        this.#assertDispatchOwned(session, task);
        if (switched.cancelled) throw new Error(`session_restore_cancelled: ${session.sessionId}`);
        const restoredState = await rpc.getState();
        this.#assertDispatchOwned(session, task);
        if (restoredState.sessionFile !== session.sessionFile) throw new Error(`session_restore_mismatch: ${session.sessionId}`);
        session.piSessionId = restoredState.sessionId;
      } else {
        session.piSessionId = state.sessionId;
        if (!state.sessionFile) throw new Error("Pi RPC did not provide a persistent session file");
        session.sessionFile = state.sessionFile;
      }
    }

    this.#assertDispatchOwned(session, task);
    session.state = "running";
    task.status = "running";
    await this.#persist();
    this.#assertDispatchOwned(session, task);
    await rpc.prompt(text);
    if (isTerminal(task)) {
      if (task.status === "completed") return;
      throw new Error(`task_cancelled: ${task.taskId} became ${task.status}`);
    }
    this.#assertDispatchOwned(session, task);
  }

  #createRpc(session: SessionRecord): PiRpcProcess {
    const options: PiRpcProcessOptions = {
      cwd: session.cwd,
      ...(this.#options.executable ? { executable: this.#options.executable } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(this.#options.commandTimeoutMs ? { commandTimeoutMs: this.#options.commandTimeoutMs } : {}),
      ...(this.#options.shutdownGraceMs ? { shutdownGraceMs: this.#options.shutdownGraceMs } : {}),
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
    };
    const rpc = this.#options.rpcFactory ? this.#options.rpcFactory(options) : new PiRpcProcess(options);
    rpc.on("event", (event: RpcEvent) => {
      if (event.type === "agent_settled") void this.#handleSettled(session, rpc);
    });
    rpc.on("exit", (error: Error) => void this.#handleExit(session, rpc, error));
    return rpc;
  }

  async #handleSettled(session: SessionRecord, rpc: PiRpcProcess): Promise<void> {
    if (session.process !== rpc || !session.activeTaskId) return;
    const task = this.#tasks.get(session.activeTaskId);
    if (!task || isTerminal(task)) return;
    try {
      const result = await rpc.getLastAssistantText();
      await this.#finalizeTask(session, task, "completed", { response: result.text ?? "" }, "idle");
    } catch (error) {
      await this.#finalizeTask(session, task, "failed", { error: errorMessage(error) }, "error");
    }
  }

  async #handleExit(session: SessionRecord, rpc: PiRpcProcess, error: Error): Promise<void> {
    if (session.process !== rpc) return;
    session.process = undefined;
    if (["closing", "closed"].includes(session.state)) return;
    const task = session.activeTaskId ? this.#tasks.get(session.activeTaskId) : undefined;
    if (task && !isTerminal(task)) {
      await this.#finalizeTask(session, task, "failed", { error: error.message }, "error");
    } else {
      session.state = "error";
      session.recoverable = Boolean(session.sessionFile);
      await this.#persist();
    }
  }

  async #failDispatch(session: SessionRecord, task: TaskRecord, error: unknown): Promise<void> {
    if (!isTerminal(task)) {
      await this.#finalizeTask(session, task, "failed", { error: errorMessage(error) }, "error");
    }
    const rpc = session.process;
    if (rpc) {
      await rpc.stop().catch(() => undefined);
      if (session.process === rpc) session.process = undefined;
    }
    session.recoverable = session.state !== "closed" && Boolean(session.sessionFile);
    await this.#persist();
  }

  #assertDispatchOwned(session: SessionRecord, task: TaskRecord): void {
    if (session.activeTaskId !== task.taskId || isTerminal(task) || ["closing", "closed"].includes(session.state)) {
      throw new Error(`task_cancelled: ${task.taskId} no longer owns session ${session.sessionId}`);
    }
  }

  async #finalizeTask(
    session: SessionRecord,
    task: TaskRecord,
    status: StoredTaskStatus,
    detail: { response?: string; error?: string },
    nextState: SessionState,
  ): Promise<boolean> {
    if (isTerminal(task)) return false;
    task.status = status;
    if (detail.response !== undefined) task.response = detail.response;
    if (detail.error !== undefined) task.error = detail.error;
    task.completedAt = new Date().toISOString();
    session.lastTask = task;
    if (session.activeTaskId === task.taskId) session.activeTaskId = null;
    session.state = nextState;
    session.recoverable = nextState === "idle" || (nextState === "error" && Boolean(session.sessionFile) && session.process === undefined);
    await this.#persist();
    this.emit("taskTerminal", task.taskId);
    return true;
  }

  #timeoutResult(ids: readonly string[]): WaitResult {
    const completed = ids.map((id) => this.#tasks.get(id)!).filter(isTerminal);
    const terminalIds = new Set(completed.map((task) => task.taskId));
    return {
      completed: completed.map(toTaskResult),
      pending: ids.filter((id) => !terminalIds.has(id)),
      timed_out: true,
    };
  }

  #fromStoredSession(stored: StoredSession, wasClean: boolean): SessionRecord {
    let lastTask = stored.lastTask ? fromStoredTask(stored.lastTask) : undefined;
    const hadActiveTask = stored.activeTaskId !== null || stored.state === "running";
    if (hadActiveTask) {
      const interruptedId = stored.activeTaskId ?? `task_interrupted_${this.#options.idFactory()}`;
      lastTask = {
        taskId: interruptedId,
        sessionId: stored.sessionId,
        status: "host_interrupted",
        error: "Previous MCP host stopped before the task completed",
        completedAt: new Date().toISOString(),
      };
    }
    return {
      sessionId: stored.sessionId,
      generation: stored.generation,
      ...(stored.name ? { name: stored.name } : {}),
      cwd: stored.cwd,
      ...(stored.model ? { model: stored.model } : {}),
      ...(stored.piSessionId ? { piSessionId: stored.piSessionId } : {}),
      ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
      state: stored.state === "closed" ? "closed" : wasClean ? "dormant" : "error",
      activeTaskId: null,
      ...(lastTask ? { lastTask } : {}),
      recoverable: stored.state !== "closed" && wasClean && Boolean(stored.sessionFile),
      process: undefined,
    };
  }

  async #persist(): Promise<void> {
    this.#manifest.sessions = Object.fromEntries([...this.#sessions.values()].map((session) => [session.sessionId, toStoredSession(session)]));
    await this.#options.store.save(this.#manifest);
  }

  #requireSession(sessionId: string): SessionRecord {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`unknown_session: ${sessionId}`);
    return session;
  }

  #assertProcessCapacity(): void {
    const activeCount = [...this.#sessions.values()].filter((session) => occupiesProcessSlot(session)).length;
    if (activeCount >= this.#options.maxSessions) {
      throw new Error(`session_limit: maximum ${this.#options.maxSessions} active Pi processes reached`);
    }
  }

  #assertAvailable(): void {
    if (this.#shuttingDown) throw new Error("server_shutting_down");
  }
}

function occupiesProcessSlot(session: SessionRecord): boolean {
  return session.process !== undefined || ["restoring", "dispatching", "running", "idle"].includes(session.state);
}

function isTerminal(task: TaskRecord): task is TaskRecord & { status: StoredTaskStatus; completedAt: string } {
  return terminalStatuses.has(task.status) && task.completedAt !== undefined;
}

function toTaskResult(task: TaskRecord & { status: StoredTaskStatus }): TaskResult {
  return {
    session_id: task.sessionId,
    task_id: task.taskId,
    status: task.status,
    ...(task.response !== undefined ? { response: task.response } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
  };
}

function toSessionStatus(session: SessionRecord): SessionStatus {
  return {
    session_id: session.sessionId,
    ...(session.name ? { name: session.name } : {}),
    cwd: session.cwd,
    ...(session.model ? { model: session.model } : {}),
    state: session.state,
    resident: session.process?.running ?? false,
    recoverable: session.recoverable,
    current_task_id: session.activeTaskId,
    ...(session.lastTask && isTerminal(session.lastTask) ? { last_task: toTaskResult(session.lastTask) } : {}),
    ...(session.piSessionId ? { pi_session_id: session.piSessionId } : {}),
    ...(session.sessionFile ? { session_file: session.sessionFile } : {}),
  };
}

function toStoredSession(session: SessionRecord): StoredSession {
  return {
    sessionId: session.sessionId,
    generation: session.generation,
    ...(session.name ? { name: session.name } : {}),
    cwd: session.cwd,
    ...(session.model ? { model: session.model } : {}),
    ...(session.piSessionId ? { piSessionId: session.piSessionId } : {}),
    ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
    state: toStoredState(session.state),
    activeTaskId: session.activeTaskId,
    ...(session.lastTask && isTerminal(session.lastTask) ? { lastTask: toStoredTask(session.lastTask) } : {}),
  };
}

function toStoredState(state: SessionState): StoredSession["state"] {
  switch (state) {
    case "restoring":
    case "dispatching":
      return "running";
    case "closing":
      return "error";
    case "dormant":
    case "running":
    case "idle":
    case "error":
    case "closed":
      return state;
  }
}

function toStoredTask(task: TaskRecord & { status: StoredTaskStatus; completedAt: string }): StoredTask {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    status: task.status,
    ...(task.response !== undefined ? { response: task.response } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    completedAt: task.completedAt,
  };
}

function fromStoredTask(task: StoredTask): TaskRecord {
  return { ...task };
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
}

async function validateCwd(cwd: string): Promise<string> {
  if (!cwd.startsWith("/")) throw new Error("cwd must be an absolute path");
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("cwd must be a directory");
  return cwd;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
