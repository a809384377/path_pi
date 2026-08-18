import { EventEmitter } from "node:events";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { PiRpcProcess, type PiRpcProcessOptions } from "../rpc/pi-rpc-process.js";
import { assistantOutcomeFromEvent, type AssistantOutcome, type RpcEvent } from "../rpc/types.js";
import {
  JsonSessionStore,
  type SessionManifest,
  type StoredSession,
  type StoredTask,
  type StoredTaskStatus,
} from "../store/session-store.js";

export type SessionState =
  | "dormant"
  | "restoring"
  | "dispatching"
  | "running"
  | "finalizing"
  | "idle"
  | "error"
  | "closing"
  | "closed";
export type TaskStatus = "dispatching" | "running" | StoredTaskStatus;

export interface TaskRecord {
  taskId: string;
  sessionId: string;
  status: TaskStatus;
  response?: string;
  error?: string;
  completedAt?: string;
  published: boolean;
  finalizing: boolean;
  promptAccepted: boolean;
  pendingSettled: boolean;
  finalizationPromise: Promise<boolean> | undefined;
  assistantOutcome?: AssistantOutcome;
  persistenceError?: string;
  nextSessionState?: SessionState;
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
  closeRequested: boolean;
  cleanupPromise: Promise<void> | undefined;
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
  cwdValidator?: (cwd: string) => Promise<string>;
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
  persistence_error?: string;
}

const terminalStatuses = new Set<TaskStatus>(["completed", "failed", "aborted", "host_interrupted"]);

export class SessionManager extends EventEmitter {
  readonly #options: Required<Pick<SessionManagerOptions, "maxSessions" | "idFactory">> & SessionManagerOptions;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #tasks = new Map<string, TaskRecord>();
  #manifest: SessionManifest = { version: 1, cleanShutdown: true, sessions: {} };
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | undefined;

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
    const cwd = await (this.#options.cwdValidator ?? validateCwd)(input.cwd);
    this.#assertAvailable();
    const activeCount = [...this.#sessions.values()].filter((session) => occupiesProcessSlot(session)).length;
    if (activeCount >= this.#options.maxSessions) {
      throw new Error(`session_limit: maximum ${this.#options.maxSessions} active Pi processes reached`);
    }

    const sessionId = `pi_${this.#options.idFactory()}`;
    const taskId = `task_${this.#options.idFactory()}`;
    const task = createTask(taskId, sessionId);
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
      closeRequested: false,
      cleanupPromise: undefined,
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
    const task = createTask(taskId, sessionId);
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
      const completed = ids.map((id) => this.#tasks.get(id)!).filter(isPublishedTerminal);
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
    session.closeRequested = true;
    await this.#cleanupSession(session, "close");
    if (session.state !== "closed") {
      session.state = "closed";
      session.recoverable = false;
      session.activeTaskId = null;
      await this.#persist();
    }
    return toSessionStatus(session);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#runShutdown();
    return this.#shutdownPromise;
  }

  async #runShutdown(): Promise<void> {
    const sessions = [...this.#sessions.values()].filter((session) => session.state !== "closed");
    await Promise.all(sessions.map((session) => this.#cleanupSession(session, "shutdown")));
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
    try {
      await rpc.prompt(text);
    } catch (error) {
      task.pendingSettled = false;
      throw error;
    }
    task.promptAccepted = true;
    if (task.pendingSettled) {
      task.pendingSettled = false;
      await this.#completeSettledTask(session, rpc, task);
    }
    if (task.published && (task.status as TaskStatus) === "completed") return;
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
      const task = session.activeTaskId ? this.#tasks.get(session.activeTaskId) : undefined;
      const outcome = assistantOutcomeFromEvent(event);
      if (task && outcome && !task.published) task.assistantOutcome = outcome;
      if (event.type === "agent_settled") this.#runBackground(session, this.#handleSettled(session, rpc));
    });
    rpc.on("exit", (error: Error) => this.#runBackground(session, this.#handleExit(session, rpc, error)));
    return rpc;
  }

  async #handleSettled(session: SessionRecord, rpc: PiRpcProcess): Promise<void> {
    if (session.process !== rpc || !session.activeTaskId) return;
    const task = this.#tasks.get(session.activeTaskId);
    if (!task || task.published || task.finalizing) return;
    if (!task.promptAccepted) {
      task.pendingSettled = true;
      return;
    }
    await this.#completeSettledTask(session, rpc, task);
  }

  async #completeSettledTask(session: SessionRecord, rpc: PiRpcProcess, task: TaskRecord): Promise<void> {
    if (task.published || task.finalizing || session.process !== rpc) return;
    const outcome = task.assistantOutcome;
    if (outcome?.errorMessage || isAssistantFailureStop(outcome?.stopReason)) {
      await this.#finalizeTask(
        session,
        task,
        "failed",
        { error: outcome?.errorMessage ?? `Pi assistant stopped with ${outcome?.stopReason ?? "an error"}` },
        "error",
      );
      return;
    }
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
    if (task?.finalizationPromise) await task.finalizationPromise;
    if (task?.persistenceError) {
      session.state = "error";
      session.recoverable = false;
      return;
    }
    if (task && !task.published) {
      await this.#finalizeTask(session, task, "failed", { error: error.message }, "error");
    } else {
      session.state = "error";
      session.recoverable = Boolean(session.sessionFile);
      await this.#persist();
    }
  }

  async #failDispatch(session: SessionRecord, task: TaskRecord, error: unknown): Promise<void> {
    if (!task.published && !task.finalizing) {
      await this.#finalizeTask(session, task, "failed", { error: errorMessage(error) }, "error");
    }
    const rpc = session.process;
    if (rpc) {
      try {
        await rpc.stop();
      } catch (stopError) {
        session.state = "error";
        session.recoverable = false;
        await this.#persist().catch(() => undefined);
        throw stopError;
      }
      if (session.process === rpc && !rpc.processOwned) session.process = undefined;
    }
    session.recoverable = session.state !== "closed" && Boolean(session.sessionFile) && session.process === undefined && !task.persistenceError;
    await this.#persist();
  }

  #assertDispatchOwned(session: SessionRecord, task: TaskRecord): void {
    if (session.activeTaskId !== task.taskId || task.published || task.finalizing || ["closing", "closed"].includes(session.state)) {
      throw new Error(`task_cancelled: ${task.taskId} no longer owns session ${session.sessionId}`);
    }
  }

  #finalizeTask(
    session: SessionRecord,
    task: TaskRecord,
    status: StoredTaskStatus,
    detail: { response?: string; error?: string },
    nextState: SessionState,
  ): Promise<boolean> {
    if (task.published) return Promise.resolve(false);
    if (task.finalizationPromise) return task.finalizationPromise;
    task.finalizing = true;
    task.status = status;
    if (detail.response !== undefined) task.response = detail.response;
    if (detail.error !== undefined) task.error = detail.error;
    task.completedAt = new Date().toISOString();
    task.nextSessionState = nextState;
    session.lastTask = task;
    session.state = "finalizing";
    session.recoverable = false;
    task.finalizationPromise = this.#persistTaskOutcome(session, task, nextState);
    return task.finalizationPromise;
  }

  async #persistTaskOutcome(session: SessionRecord, task: TaskRecord, nextState: SessionState): Promise<boolean> {
    try {
      await this.#persist();
    } catch (error) {
      task.persistenceError = errorMessage(error);
      task.finalizing = false;
      session.state = "error";
      session.recoverable = false;
      this.emit("taskPersistenceError", task.taskId, error);
      return false;
    }
    task.published = true;
    task.finalizing = false;
    session.lastTask = task;
    if (session.activeTaskId === task.taskId) session.activeTaskId = null;
    session.state = nextState;
    session.recoverable = nextState === "idle" || (nextState === "error" && Boolean(session.sessionFile) && session.process === undefined);
    this.emit("taskTerminal", task.taskId);
    return true;
  }

  #timeoutResult(ids: readonly string[]): WaitResult {
    const completed = ids.map((id) => this.#tasks.get(id)!).filter(isPublishedTerminal);
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
        published: true,
        finalizing: false,
        promptAccepted: true,
        pendingSettled: false,
        finalizationPromise: undefined,
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
      closeRequested: stored.state === "closed",
      cleanupPromise: undefined,
    };
  }

  async #cleanupSession(session: SessionRecord, intent: "close" | "shutdown"): Promise<void> {
    if (intent === "close") session.closeRequested = true;
    if (session.state === "closed") return;
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleanupPromise = this.#runCleanup(session);
    return session.cleanupPromise;
  }

  async #runCleanup(session: SessionRecord): Promise<void> {
    session.state = "closing";
    session.recoverable = false;
    const task = session.activeTaskId ? this.#tasks.get(session.activeTaskId) : undefined;
    if (task?.finalizationPromise) await task.finalizationPromise;
    if (task?.persistenceError) {
      session.state = "error";
      session.recoverable = false;
      throw new Error(`Failed to persist terminal outcome for ${task.taskId}: ${task.persistenceError}`);
    }
    if (task && !task.published) {
      const published = await this.#finalizeTask(
        session,
        task,
        session.closeRequested ? "aborted" : "host_interrupted",
        { error: session.closeRequested ? "Session was closed" : "MCP host shut down" },
        "closing",
      );
      if (!published) throw new Error(`Failed to persist terminal outcome for ${task.taskId}`);
    } else {
      await this.#persist();
    }

    const rpc = session.process;
    if (rpc) {
      const graceMs = this.#options.shutdownGraceMs ?? 1_000;
      const [abortResult, stopResult] = await Promise.allSettled([rpc.abort(graceMs), rpc.stop()]);
      void abortResult;
      if (stopResult.status === "rejected" || rpc.processOwned) {
        session.state = "error";
        session.recoverable = false;
        await this.#persist().catch(() => undefined);
        throw stopResult.status === "rejected" ? stopResult.reason : new Error(`Pi process ${rpc.pid ?? "unknown"} exit not confirmed`);
      }
      if (session.process === rpc) session.process = undefined;
    }

    session.activeTaskId = null;
    session.state = session.closeRequested ? "closed" : session.sessionFile ? "dormant" : "error";
    session.recoverable = !session.closeRequested && Boolean(session.sessionFile);
    await this.#persist();
  }

  async #persist(): Promise<void> {
    this.#manifest.sessions = Object.fromEntries([...this.#sessions.values()].map((session) => [session.sessionId, toStoredSession(session)]));
    await this.#options.store.save(this.#manifest);
  }

  #runBackground(session: SessionRecord, operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      session.state = "error";
      session.recoverable = false;
      this.#options.logger?.(`Pi session ${session.sessionId} background failure: ${errorMessage(error)}\n`);
    });
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

function createTask(taskId: string, sessionId: string): TaskRecord {
  return {
    taskId,
    sessionId,
    status: "dispatching",
    published: false,
    finalizing: false,
    promptAccepted: false,
    pendingSettled: false,
    finalizationPromise: undefined,
  };
}

function occupiesProcessSlot(session: SessionRecord): boolean {
  return session.process !== undefined || ["restoring", "dispatching", "running", "finalizing", "idle"].includes(session.state);
}

function isCandidateTerminal(task: TaskRecord): task is TaskRecord & { status: StoredTaskStatus; completedAt: string } {
  return terminalStatuses.has(task.status) && task.completedAt !== undefined;
}

function isPublishedTerminal(task: TaskRecord): task is TaskRecord & { status: StoredTaskStatus; completedAt: string } {
  return task.published && isCandidateTerminal(task);
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
    resident: session.process?.processOwned ?? false,
    recoverable: session.recoverable,
    current_task_id: session.activeTaskId,
    ...(session.lastTask && isPublishedTerminal(session.lastTask) ? { last_task: toTaskResult(session.lastTask) } : {}),
    ...(session.piSessionId ? { pi_session_id: session.piSessionId } : {}),
    ...(session.sessionFile ? { session_file: session.sessionFile } : {}),
    ...(session.lastTask?.persistenceError ? { persistence_error: session.lastTask.persistenceError } : {}),
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
    state: session.state === "finalizing" && session.lastTask?.nextSessionState ? toStoredState(session.lastTask.nextSessionState) : toStoredState(session.state),
    activeTaskId: session.state === "finalizing" ? null : session.activeTaskId,
    ...(session.lastTask && (session.lastTask.published || session.lastTask.finalizing) && isCandidateTerminal(session.lastTask)
      ? { lastTask: toStoredTask(session.lastTask) }
      : {}),
  };
}

function toStoredState(state: SessionState): StoredSession["state"] {
  switch (state) {
    case "restoring":
    case "dispatching":
      return "running";
    case "closing":
    case "finalizing":
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
  return {
    ...task,
    published: true,
    finalizing: false,
    promptAccepted: true,
    pendingSettled: false,
    finalizationPromise: undefined,
  };
}


function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must not be empty`);
  return trimmed;
}

async function validateCwd(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("cwd must be a directory");
  return cwd;
}

function isAssistantFailureStop(stopReason: string | undefined): boolean {
  return stopReason !== undefined && ["error", "aborted", "cancelled", "canceled"].includes(stopReason.toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
