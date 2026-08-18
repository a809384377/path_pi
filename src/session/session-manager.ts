import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PiRpcProcess, type PiRpcProcessOptions } from "../rpc/pi-rpc-process.js";
import { assistantOutcomeFromEvent, type AssistantOutcome, type RpcEvent } from "../rpc/types.js";
import { OwnershipLockManager, SessionOwnership } from "../ownership/session-ownership.js";
import { LegacyJsonSessionStore, type StoredTask, type StoredTaskStatus } from "../store/legacy-session-store.js";
import { readPiSessionIdentity, type PiSessionIdentity } from "../store/pi-session-header.js";
import { assertNoSymlinkComponents, assertPrivateDirectory, ensurePrivateDirectory } from "../store/secure-fs.js";
import {
  SessionRecordStore,
  sessionRecordHash,
  type SessionRecordV2,
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
  generation: number;
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
}

interface ResidentSession {
  record: SessionRecordV2;
  state: SessionState;
  process: PiRpcProcess | undefined;
  ownership: SessionOwnership | undefined;
  activeTask: TaskRecord | undefined;
  closeRequested: boolean;
  cleanupPromise: Promise<void> | undefined;
  cleanupStopFailed: boolean;
  cleanupIntent: "close" | "shutdown" | undefined;
  verifiedIdentity: PiSessionIdentity | undefined;
}

export interface SessionManagerOptions {
  store: SessionRecordStore | LegacyJsonSessionStore;
  ownership?: OwnershipLockManager;
  executable?: string;
  maxSessions?: number;
  commandTimeoutMs?: number;
  shutdownGraceMs?: number;
  rpcFactory?: (options: PiRpcProcessOptions) => PiRpcProcess;
  idFactory?: () => string;
  nativeIdFactory?: () => string;
  logger?: (message: string) => void;
  cwdValidator?: (cwd: string) => Promise<string>;
}

export interface SpawnInput { task: string; cwd: string; name?: string; model?: string }
export interface DispatchResult { session_id: string; task_id: string; status: "running" }
export interface WaitResult { completed: TaskResult[]; pending: string[]; timed_out: boolean }
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
  readonly #options: Required<Pick<SessionManagerOptions, "maxSessions" | "idFactory" | "nativeIdFactory">> & SessionManagerOptions;
  readonly #store: SessionRecordStore;
  readonly #locks: OwnershipLockManager;
  readonly #sessions = new Map<string, ResidentSession>();
  readonly #tasks = new Map<string, TaskRecord>();
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | undefined;
  readonly #admissions = new Set<Promise<void>>();

  constructor(options: SessionManagerOptions) {
    super();
    const store = options.store instanceof SessionRecordStore
      ? options.store
      : new SessionRecordStore(dirname(options.store.path));
    this.#store = store;
    this.#locks = options.ownership ?? new OwnershipLockManager(store.root);
    this.#options = {
      ...options,
      maxSessions: options.maxSessions ?? 16,
      idFactory: options.idFactory ?? randomUUID,
      nativeIdFactory: options.nativeIdFactory ?? randomUUID,
    };
  }

  get recordStore(): SessionRecordStore {
    return this.#store;
  }

  get ownershipManager(): OwnershipLockManager {
    return this.#locks;
  }

  async initialize(): Promise<void> {
    await this.#locks.initialize();
    await ensurePrivateDirectory(join(this.#store.root, "pi-sessions"));
    for (const record of await this.#store.list()) this.#cacheDiskRecord(record);
  }

  async spawn(input: SpawnInput): Promise<DispatchResult> {
    const leave = this.#enterAdmission();
    try {
      return await this.#spawnAdmitted(input);
    } finally {
      leave();
    }
  }

  async #spawnAdmitted(input: SpawnInput): Promise<DispatchResult> {
    this.#assertAvailable();
    const text = requireNonEmpty(input.task, "task");
    const cwd = await (this.#options.cwdValidator ?? validateCwd)(input.cwd);
    this.#assertAvailable();
    this.#assertProcessCapacity();

    const sessionId = `pi_${this.#options.idFactory()}`;
    const nativeId = this.#options.nativeIdFactory();
    const taskId = `task_${this.#options.idFactory()}`;
    const task = createTask(taskId, sessionId, 1);
    const ownership = await this.#locks.acquireSession(sessionId, nativeId, { purpose: "new-session" });
    const sessionDirectory = join(this.#store.root, "pi-sessions", sessionRecordHash(sessionId));
    let session: ResidentSession | undefined;
    try {
      await ensureExclusiveEmptyDirectory(sessionDirectory);
      const now = new Date().toISOString();
      const record: SessionRecordV2 = {
        version: 2,
        sessionId,
        revision: 1,
        generation: 1,
        ...(input.name ? { name: input.name } : {}),
        cwd,
        ...(input.model ? { model: input.model } : {}),
        piSessionId: nativeId,
        state: "creating",
        recoverable: false,
        activeTaskId: taskId,
        updatedAt: now,
      };
      await this.#store.create(record);
      session = {
        record,
        state: "dispatching",
        process: undefined,
        ownership,
        activeTask: task,
        closeRequested: false,
        cleanupPromise: undefined,
        cleanupStopFailed: false,
        cleanupIntent: undefined,
        verifiedIdentity: undefined,
      };
      this.#sessions.set(sessionId, session);
      this.#tasks.set(taskId, task);
      const rpc = this.#createRpc(session, {
        kind: "new",
        sessionDirectory,
        sessionId: nativeId,
      });
      session.process = rpc;
      const state = await rpc.start();
      this.#assertTaskOwner(session, task);
      const intended = validateNewState(state.sessionId, state.sessionFile, nativeId, sessionDirectory);
      await assertPathMissing(intended);
      await this.#mutate(session, {
        ...session.record,
        revision: session.record.revision + 1,
        state: "running",
        recoverable: false,
        sessionFile: intended,
        updatedAt: new Date().toISOString(),
      });
      session.state = "running";
      task.status = "running";
      await this.#prompt(session, task, rpc, text);
      return { session_id: sessionId, task_id: taskId, status: "running" };
    } catch (error) {
      if (session) await this.#failDispatch(session, task, error);
      else await ownership.close().catch(() => undefined);
      throw error;
    }
  }

  async send(sessionId: string, taskText: string): Promise<DispatchResult> {
    const leave = this.#enterAdmission();
    try {
      return await this.#sendAdmitted(sessionId, taskText);
    } finally {
      leave();
    }
  }

  async #sendAdmitted(sessionId: string, taskText: string): Promise<DispatchResult> {
    this.#assertAvailable();
    const text = requireNonEmpty(taskText, "task");
    let session = await this.#loadSession(sessionId);
    if (session.record.state === "closed") throw new Error(`session_closed: ${sessionId}`);
    if (session.record.state === "migration_blocked") throw new Error(`migration_blocked: ${sessionId}`);
    const crashRecord = session.record.state === "creating" || (session.record.state === "running" && !session.record.recoverable);
    if (session.activeTask || (session.ownership?.held && session.record.activeTaskId && !crashRecord)) {
      throw new Error(`session_busy: ${sessionId} has an active task`);
    }

    if (session.process && session.ownership?.held) {
      if (!session.record.recoverable) throw new Error(`session_not_recoverable: ${sessionId}`);
      return this.#dispatchResident(session, text);
    }
    this.#assertProcessCapacity();
    session = await this.#acquireForRestore(session.record);
    if (!session.record.recoverable) {
      await this.#releaseOwnership(session);
      throw new Error(`session_not_recoverable: ${sessionId}`);
    }

    const taskId = `task_${this.#options.idFactory()}`;
    const task = createTask(taskId, sessionId, session.record.generation + 1);
    session.activeTask = task;
    session.state = "restoring";
    this.#tasks.set(taskId, task);
    try {
      await this.#assertLaunchIdentity(session);
      const rpc = this.#createRpc(session, { kind: "restore", sessionFile: session.record.sessionFile! });
      session.process = rpc;
      const state = await rpc.start();
      await this.#assertLaunchIdentity(session);
      this.#assertTaskOwner(session, task);
      if (state.sessionId !== session.record.piSessionId || resolve(state.sessionFile ?? "") !== resolve(session.record.sessionFile!)) {
        throw new Error(`session_restore_mismatch: ${sessionId}`);
      }
      if (session.record.state === "running" || session.record.activeTaskId) await this.#interruptStaleTask(session);
      await this.#publishRunningTask(session, task);
      await this.#prompt(session, task, rpc, text);
      return { session_id: sessionId, task_id: taskId, status: "running" };
    } catch (error) {
      await this.#failDispatch(session, task, error);
      throw error;
    }
  }

  async #dispatchResident(session: ResidentSession, text: string): Promise<DispatchResult> {
    const taskId = `task_${this.#options.idFactory()}`;
    const task = createTask(taskId, session.record.sessionId, session.record.generation + 1);
    session.activeTask = task;
    this.#tasks.set(taskId, task);
    try {
      await this.#publishRunningTask(session, task);
      await this.#prompt(session, task, session.process!, text);
      return { session_id: session.record.sessionId, task_id: taskId, status: "running" };
    } catch (error) {
      await this.#failDispatch(session, task, error);
      throw error;
    }
  }

  async wait(taskIds: readonly string[], mode: "any" | "all" = "any", timeoutMs = 60_000): Promise<WaitResult> {
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) throw new Error("task_ids must not be empty");
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeout must be a non-negative finite number");
    for (const id of ids) if (!this.#tasks.has(id)) throw new Error(`unknown_task: ${id}`);
    const evaluate = (): WaitResult | undefined => {
      const completed = ids.map((id) => this.#tasks.get(id)!).filter(isPublishedTerminal);
      const ready = mode === "all" ? completed.length === ids.length : completed.length > 0;
      if (!ready) return undefined;
      const done = new Set(completed.map((task) => task.taskId));
      return { completed: completed.map(toTaskResult), pending: ids.filter((id) => !done.has(id)), timed_out: false };
    };
    const immediate = evaluate();
    if (immediate) return immediate;
    if (timeoutMs === 0) return this.#timeoutResult(ids);
    return new Promise<WaitResult>((resolveWait, rejectWait) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off("taskTerminal", onTerminal);
        this.off("taskPersistenceError", onPersistence);
      };
      const finish = (value: WaitResult): void => { if (!settled) { settled = true; cleanup(); resolveWait(value); } };
      const fail = (error: Error): void => { if (!settled) { settled = true; cleanup(); rejectWait(error); } };
      const onPersistence = (taskId: string): void => {
        if (!ids.includes(taskId)) return;
        const task = this.#tasks.get(taskId);
        if (task?.persistenceError) fail(new Error(`persistence_error: task ${taskId}: ${task.persistenceError}`));
      };
      const onTerminal = (): void => { const value = evaluate(); if (value) finish(value); };
      this.on("taskTerminal", onTerminal);
      this.on("taskPersistenceError", onPersistence);
      const timer = setTimeout(() => finish(this.#timeoutResult(ids)), timeoutMs);
      onTerminal();
    });
  }

  status(sessionId: string): SessionStatus;
  status(): SessionStatus[];
  status(sessionId?: string): SessionStatus | SessionStatus[] {
    if (sessionId) {
      const session = this.#sessions.get(sessionId);
      if (!session) throw new Error(`unknown_session: ${sessionId}`);
      return toSessionStatus(session);
    }
    return [...this.#sessions.values()].filter((session) => session.record.state !== "closed").map(toSessionStatus);
  }

  async close(sessionId: string): Promise<SessionStatus> {
    const leave = this.#enterAdmission();
    try {
      return await this.#closeAdmitted(sessionId);
    } finally {
      leave();
    }
  }

  async #closeAdmitted(sessionId: string): Promise<SessionStatus> {
    let session = await this.#loadSession(sessionId);
    if (session.record.state === "closed") return toSessionStatus(session);
    if (session.process || session.ownership?.held) {
      session.closeRequested = true;
      await this.#cleanupSession(session, "close");
      return toSessionStatus(session);
    }
    session = await this.#acquireForRemoteClose(session.record);
    session.closeRequested = true;
    const lastTask = session.record.activeTaskId
      ? interruptedTask(session.record.activeTaskId, sessionId, "Session was closed by another MCP host")
      : session.record.lastTask;
    await this.#mutate(session, {
      ...session.record,
      revision: session.record.revision + 1,
      state: "closed",
      recoverable: false,
      activeTaskId: null,
      ...(lastTask ? { lastTask } : {}),
      updatedAt: new Date().toISOString(),
    });
    session.state = "closed";
    await this.#releaseOwnership(session);
    return toSessionStatus(session);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    const attempt = this.#runShutdown();
    this.#shutdownPromise = attempt;
    void attempt.catch(() => {
      if (this.#shutdownPromise === attempt) this.#shutdownPromise = undefined;
    });
    return attempt;
  }

  async #runShutdown(): Promise<void> {
    await Promise.all([...this.#admissions]);
    const owned = [...this.#sessions.values()].filter((session) => session.ownership?.held);
    const outcomes = await Promise.allSettled(owned.map((session) => this.#cleanupSession(session, "shutdown")));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected").map((outcome) => outcome.reason);
    if (failures.length > 0) throw new AggregateError(failures, `Failed to cleanly shut down ${failures.length} Pi session(s)`);
  }

  async #acquireForRestore(initial: SessionRecordV2): Promise<ResidentSession> {
    if (initial.state === "creating" || (initial.state === "running" && !initial.recoverable)) {
      return this.#reconcile(initial);
    }
    if (!initial.recoverable || !initial.sessionFile || !initial.piSessionId) {
      throw new Error(`session_not_recoverable: ${initial.sessionId}`);
    }
    const logical = await this.#locks.acquire("logical", initial.sessionId, { purpose: "restore" });
    try {
      const identity = await readPiSessionIdentity(initial.sessionFile);
      if (identity.sessionId !== initial.piSessionId) throw new Error(`session_identity_mismatch: ${initial.sessionId}`);
      const native = await this.#locks.acquire("native", identity.sessionId, { purpose: "restore", sessionId: initial.sessionId });
      const ownership = new SessionOwnership(logical, native);
      try {
        const fresh = await this.#store.read(initial.sessionId);
        if (fresh.revision !== initial.revision || fresh.sessionFile !== initial.sessionFile) throw new Error(`revision_conflict: ${initial.sessionId}`);
        const verifiedIdentity = await assertIdentityUnchanged(identity);
        const session = this.#residentFromRecord(fresh);
        session.ownership = ownership;
        session.verifiedIdentity = verifiedIdentity;
        this.#sessions.set(fresh.sessionId, session);
        return session;
      } catch (error) {
        await ownership.close();
        throw error;
      }
    } catch (error) {
      await logical.close().catch(() => undefined);
      throw error;
    }
  }

  async #reconcile(initial: SessionRecordV2): Promise<ResidentSession> {
    if (!initial.piSessionId) throw new Error(`session_not_recoverable: ${initial.sessionId} has no native identity`);
    const ownership = await this.#locks.acquireSession(initial.sessionId, initial.piSessionId, { purpose: "crash-reconciliation" });
    const session = this.#residentFromRecord(initial);
    session.ownership = ownership;
    this.#sessions.set(initial.sessionId, session);
    try {
      const fresh = await this.#store.read(initial.sessionId);
      if (fresh.revision !== initial.revision || fresh.piSessionId !== initial.piSessionId) throw new Error(`revision_conflict: ${initial.sessionId}`);
      let valid = false;
      let verifiedIdentity: PiSessionIdentity | undefined;
      if (fresh.sessionFile && isExclusiveSessionPath(this.#store.root, fresh.sessionId, fresh.sessionFile)) {
        try {
          await assertPrivateDirectory(join(this.#store.root, "pi-sessions", sessionRecordHash(fresh.sessionId)));
          const identity = await readPiSessionIdentity(fresh.sessionFile);
          valid = identity.sessionId === fresh.piSessionId;
          if (valid) verifiedIdentity = identity;
        } catch {}
      }
      const lastTask = fresh.activeTaskId
        ? interruptedTask(fresh.activeTaskId, fresh.sessionId, "Previous MCP host stopped before the task completed")
        : fresh.lastTask;
      await this.#mutate(session, {
        ...fresh,
        revision: fresh.revision + 1,
        state: valid ? "dormant" : "error",
        recoverable: valid,
        activeTaskId: null,
        ...(lastTask ? { lastTask } : {}),
        updatedAt: new Date().toISOString(),
      });
      session.state = valid ? "dormant" : "error";
      session.verifiedIdentity = verifiedIdentity;
      if (lastTask) this.#tasks.set(lastTask.taskId, fromStoredTask(lastTask, fresh.generation));
      return session;
    } catch (error) {
      await this.#releaseOwnership(session).catch(() => undefined);
      throw error;
    }
  }

  async #acquireForRemoteClose(initial: SessionRecordV2): Promise<ResidentSession> {
    let ownership: SessionOwnership;
    if (initial.recoverable && initial.sessionFile && initial.piSessionId) {
      const logical = await this.#locks.acquire("logical", initial.sessionId, { purpose: "remote-close" });
      try {
        const identity = await readPiSessionIdentity(initial.sessionFile);
        if (identity.sessionId !== initial.piSessionId) throw new Error(`session_identity_mismatch: ${initial.sessionId}`);
        const native = await this.#locks.acquire("native", identity.sessionId, { purpose: "remote-close" });
        ownership = new SessionOwnership(logical, native);
      } catch (error) {
        await logical.close();
        throw error;
      }
    } else {
      if (!initial.piSessionId) throw new Error(`session_not_recoverable: ${initial.sessionId} has no native identity`);
      ownership = await this.#locks.acquireSession(initial.sessionId, initial.piSessionId, { purpose: "remote-close" });
    }
    try {
      const fresh = await this.#store.read(initial.sessionId);
      if (fresh.revision !== initial.revision) throw new Error(`revision_conflict: ${initial.sessionId}`);
      const session = this.#residentFromRecord(fresh);
      session.ownership = ownership;
      this.#sessions.set(initial.sessionId, session);
      return session;
    } catch (error) {
      await ownership.close().catch(() => undefined);
      throw error;
    }
  }

  async #interruptStaleTask(session: ResidentSession): Promise<void> {
    const taskId = session.record.activeTaskId;
    const lastTask = taskId
      ? interruptedTask(taskId, session.record.sessionId, "Previous MCP host stopped before the task completed")
      : session.record.lastTask;
    await this.#mutate(session, {
      ...session.record,
      revision: session.record.revision + 1,
      state: "dormant",
      activeTaskId: null,
      ...(lastTask ? { lastTask } : {}),
      updatedAt: new Date().toISOString(),
    });
    if (lastTask) this.#tasks.set(lastTask.taskId, fromStoredTask(lastTask, session.record.generation));
  }

  async #publishRunningTask(session: ResidentSession, task: TaskRecord): Promise<void> {
    await this.#mutate(session, {
      ...session.record,
      revision: session.record.revision + 1,
      generation: task.generation,
      state: "running",
      activeTaskId: task.taskId,
      updatedAt: new Date().toISOString(),
    });
    session.state = "running";
    task.status = "running";
  }

  async #prompt(session: ResidentSession, task: TaskRecord, rpc: PiRpcProcess, text: string): Promise<void> {
    this.#assertTaskOwner(session, task);
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
    if (task.published) return;
    this.#assertTaskOwner(session, task, true);
  }

  async #assertLaunchIdentity(session: ResidentSession): Promise<void> {
    const identity = session.verifiedIdentity;
    if (!identity) throw new Error(`session_identity_unverified: ${session.record.sessionId}`);
    session.verifiedIdentity = await assertIdentityUnchanged(identity);
  }

  #createRpc(session: ResidentSession, startup: NonNullable<PiRpcProcessOptions["startup"]>): PiRpcProcess {
    if (!session.ownership?.held) throw new Error(`ownership_unavailable: ${session.record.sessionId}`);
    const options: PiRpcProcessOptions = {
      cwd: session.record.cwd,
      startup,
      ownershipFds: session.ownership.inheritedFds,
      ...(this.#options.executable ? { executable: this.#options.executable } : {}),
      ...(session.record.model ? { model: session.record.model } : {}),
      ...(this.#options.commandTimeoutMs ? { commandTimeoutMs: this.#options.commandTimeoutMs } : {}),
      ...(this.#options.shutdownGraceMs ? { shutdownGraceMs: this.#options.shutdownGraceMs } : {}),
      ...(this.#options.logger ? { logger: this.#options.logger } : {}),
    };
    const rpc = this.#options.rpcFactory ? this.#options.rpcFactory(options) : new PiRpcProcess(options);
    rpc.on("event", (event: RpcEvent) => {
      const task = session.activeTask;
      const outcome = assistantOutcomeFromEvent(event);
      if (task && outcome && !task.published) task.assistantOutcome = outcome;
      if (event.type === "agent_settled") this.#background(session, this.#handleSettled(session, rpc));
    });
    rpc.on("exit", (error: Error) => this.#background(session, this.#handleExit(session, rpc, error)));
    return rpc;
  }

  async #handleSettled(session: ResidentSession, rpc: PiRpcProcess): Promise<void> {
    const task = session.activeTask;
    if (!task || session.process !== rpc || task.published || task.finalizing) return;
    if (!task.promptAccepted) { task.pendingSettled = true; return; }
    await this.#completeSettledTask(session, rpc, task);
  }

  #completeSettledTask(session: ResidentSession, rpc: PiRpcProcess, task: TaskRecord): Promise<boolean> {
    if (session.process !== rpc || task.published) return Promise.resolve(task.published);
    if (task.finalizing && task.finalizationPromise) return task.finalizationPromise;
    if (isKnownTerminal(task)) return this.#startKnownTerminalPublication(session, task);
    task.finalizing = true;
    if (!session.cleanupIntent) session.state = "finalizing";
    let resolveAttempt!: (value: boolean) => void;
    let rejectAttempt!: (error: unknown) => void;
    const attempt = new Promise<boolean>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    task.finalizationPromise = attempt;
    void this.#deriveAndPublishSettledTask(session, rpc, task).then(resolveAttempt, rejectAttempt);
    return attempt;
  }

  async #deriveAndPublishSettledTask(session: ResidentSession, rpc: PiRpcProcess, task: TaskRecord): Promise<boolean> {
    const outcome = task.assistantOutcome;
    if (outcome?.errorMessage || isAssistantFailureStop(outcome?.stopReason)) {
      setKnownTerminal(
        task,
        "failed",
        { error: outcome?.errorMessage ?? `Pi assistant stopped with ${outcome?.stopReason ?? "an error"}` },
      );
    } else {
      try {
        const result = await rpc.getLastAssistantText();
        setKnownTerminal(task, "completed", { response: result.text ?? "" });
      } catch (error) {
        setKnownTerminal(task, "failed", { error: errorMessage(error) });
      }
    }
    return this.#publishKnownTerminal(session, task);
  }

  #finalizeTask(
    session: ResidentSession,
    task: TaskRecord,
    status: StoredTaskStatus,
    detail: { response?: string; error?: string },
  ): Promise<boolean> {
    if (task.published) return Promise.resolve(true);
    if (task.finalizing && task.finalizationPromise) return task.finalizationPromise;
    if (!isKnownTerminal(task)) setKnownTerminal(task, status, detail);
    return this.#startKnownTerminalPublication(session, task);
  }

  #startKnownTerminalPublication(session: ResidentSession, task: TaskRecord): Promise<boolean> {
    task.finalizing = true;
    delete task.persistenceError;
    if (!session.cleanupIntent) session.state = "finalizing";
    let resolveAttempt!: (value: boolean) => void;
    let rejectAttempt!: (error: unknown) => void;
    const attempt = new Promise<boolean>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    task.finalizationPromise = attempt;
    void this.#publishKnownTerminal(session, task).then(resolveAttempt, rejectAttempt);
    return attempt;
  }

  async #publishKnownTerminal(session: ResidentSession, task: TaskRecord): Promise<boolean> {
    const recoverable = await this.#recordIdentityValid(session.record);
    try {
      const stored = toStoredTask(task);
      await this.#mutate(session, {
        ...session.record,
        revision: session.record.revision + 1,
        state: recoverable ? (task.status === "completed" ? "idle" : "error") : "error",
        recoverable,
        activeTaskId: null,
        lastTask: stored,
        updatedAt: new Date().toISOString(),
      });
      task.published = true;
      task.finalizing = false;
      session.activeTask = undefined;
      if (!session.cleanupIntent) session.state = recoverable ? (task.status === "completed" ? "idle" : "error") : "error";
      this.emit("taskTerminal", task.taskId);
      return true;
    } catch (error) {
      task.persistenceError = errorMessage(error);
      task.finalizing = false;
      if (!session.cleanupIntent) session.state = "error";
      this.emit("taskPersistenceError", task.taskId, error);
      return false;
    }
  }

  async #awaitTaskFinalization(task: TaskRecord | undefined): Promise<void> {
    if (!task) return;
    let observed = task.finalizationPromise;
    while (observed) {
      await observed;
      if (task.finalizationPromise === observed) return;
      observed = task.finalizationPromise;
    }
  }

  async #ensureKnownTerminalPublished(session: ResidentSession, task: TaskRecord): Promise<void> {
    await this.#awaitTaskFinalization(task);
    if (task.published) return;
    if (!isKnownTerminal(task)) throw new Error(`task_terminal_unknown: ${task.taskId}`);
    const durable = await this.#startKnownTerminalPublication(session, task);
    if (!durable) throw new Error(`persistence_error: task ${task.taskId}: ${task.persistenceError ?? "unknown"}`);
  }

  async #handleExit(session: ResidentSession, rpc: PiRpcProcess, error: Error): Promise<void> {
    if (session.process !== rpc) return;
    session.process = undefined;
    if (session.state === "closed") return;
    if (session.cleanupIntent || session.state === "closing") {
      if (session.cleanupStopFailed) {
        session.cleanupStopFailed = false;
        session.cleanupPromise = undefined;
        await this.#cleanupSession(session, session.cleanupIntent ?? (session.closeRequested ? "close" : "shutdown"));
      }
      return;
    }
    const task = session.activeTask;
    if (task?.finalizationPromise) await task.finalizationPromise;
    let durable = true;
    if (task && !task.published) {
      durable = await this.#finalizeTask(session, task, "failed", { error: error.message });
    } else if (session.record.state !== "closed") {
      const recoverable = await this.#recordIdentityValid(session.record);
      try {
        await this.#mutate(session, {
          ...session.record,
          revision: session.record.revision + 1,
          state: recoverable ? "dormant" : "error",
          recoverable,
          updatedAt: new Date().toISOString(),
        });
      } catch {
        durable = false;
      }
    }
    if (durable && !rpc.processOwned) await this.#releaseOwnership(session).catch(() => undefined);
  }

  async #failDispatch(session: ResidentSession, task: TaskRecord, error: unknown): Promise<void> {
    const rpc = session.process;
    if (rpc) {
      session.state = "closing";
      try {
        await rpc.stop();
        if (rpc.processOwned) throw new Error(`Pi process group ${rpc.pid ?? "unknown"} exit not confirmed`);
        if (session.process === rpc) session.process = undefined;
      } catch (stopError) {
        session.state = "error";
        throw stopError;
      }
    }
    if (!task.published && !session.closeRequested && session.record.state !== "closed") {
      const durable = await this.#finalizeTask(session, task, "failed", { error: errorMessage(error) });
      if (!durable) throw new Error(`persistence_error: task ${task.taskId}: ${task.persistenceError ?? "unknown"}`);
    }
    if (session.ownership?.held) await this.#releaseOwnership(session);
  }

  async #cleanupSession(session: ResidentSession, intent: "close" | "shutdown"): Promise<void> {
    if (intent === "close") session.closeRequested = true;
    if (session.record.state === "closed" && !session.ownership?.held) return;
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleanupIntent = session.closeRequested ? "close" : intent;
    const attempt = this.#runCleanup(session);
    session.cleanupPromise = attempt;
    let succeeded = false;
    try {
      await attempt;
      succeeded = true;
    } finally {
      if (session.cleanupPromise === attempt) session.cleanupPromise = undefined;
      if (succeeded) session.cleanupIntent = undefined;
    }
  }

  async #runCleanup(session: ResidentSession): Promise<void> {
    session.state = "closing";
    const activeAtCleanup = session.activeTask;
    await this.#awaitTaskFinalization(activeAtCleanup);
    const rpc = session.process;
    if (rpc) {
      const grace = this.#options.shutdownGraceMs ?? 1_000;
      await Promise.allSettled([rpc.abort(grace)]);
      try {
        await rpc.stop();
      } catch (error) {
        session.cleanupStopFailed = true;
        throw error;
      }
      if (rpc.processOwned) {
        session.cleanupStopFailed = true;
        throw new Error(`Pi process group ${rpc.pid ?? "unknown"} exit not confirmed`);
      }
      if (session.process === rpc) session.process = undefined;
    }

    // abort/stop may synchronously emit agent_settled and install a new
    // finalization promise after the first sample. Always drain it before any
    // cleanup mutation so record revisions remain serialized.
    await this.#awaitTaskFinalization(activeAtCleanup);
    const task = session.activeTask ?? activeAtCleanup;
    if (task && !task.published) {
      if (!isKnownTerminal(task)) {
        setKnownTerminal(
          task,
          session.closeRequested ? "aborted" : "host_interrupted",
          { error: session.closeRequested ? "Session was closed" : "MCP host shut down" },
        );
      }
      await this.#ensureKnownTerminalPublished(session, task);
    }

    const recoverable = !session.closeRequested && await this.#recordIdentityValid(session.record);
    await this.#mutate(session, {
      ...session.record,
      revision: session.record.revision + 1,
      state: session.closeRequested ? "closed" : recoverable ? "dormant" : "error",
      recoverable,
      activeTaskId: null,
      updatedAt: new Date().toISOString(),
    });
    session.activeTask = undefined;
    session.state = session.closeRequested ? "closed" : recoverable ? "dormant" : "error";
    await this.#releaseOwnership(session);
  }

  async #recordIdentityValid(record: SessionRecordV2): Promise<boolean> {
    if (!record.sessionFile || !record.piSessionId) return false;
    try { return (await readPiSessionIdentity(record.sessionFile)).sessionId === record.piSessionId; }
    catch { return false; }
  }

  async #releaseOwnership(session: ResidentSession): Promise<void> {
    if (session.process?.processOwned) throw new Error(`ownership_release_blocked: Pi process group ${session.process.pid ?? "unknown"} remains alive`);
    await this.#store.drain(session.record.sessionId);
    const ownership = session.ownership;
    if (!ownership) return;
    await ownership.close();
    session.ownership = undefined;
  }

  async #mutate(session: ResidentSession, next: SessionRecordV2): Promise<void> {
    await this.#store.updateOwned(session.record.sessionId, session.record.revision, next);
    session.record = next;
  }

  async #loadSession(sessionId: string): Promise<ResidentSession> {
    const local = this.#sessions.get(sessionId);
    if (local?.ownership?.held || local?.process) return local;
    const record = await this.#store.read(sessionId);
    const session = this.#residentFromRecord(record);
    this.#sessions.set(sessionId, session);
    return session;
  }

  #cacheDiskRecord(record: SessionRecordV2): void {
    const session = this.#residentFromRecord(record);
    this.#sessions.set(record.sessionId, session);
    if (record.lastTask) this.#tasks.set(record.lastTask.taskId, fromStoredTask(record.lastTask, record.generation));
  }

  #residentFromRecord(record: SessionRecordV2): ResidentSession {
    return {
      record,
      state: toRuntimeState(record.state),
      process: undefined,
      ownership: undefined,
      activeTask: undefined,
      closeRequested: record.state === "closed",
      cleanupPromise: undefined,
      cleanupStopFailed: false,
      cleanupIntent: undefined,
      verifiedIdentity: undefined,
    };
  }

  #assertTaskOwner(session: ResidentSession, task: TaskRecord, allowPublished = false): void {
    if (session.activeTask !== task || (!allowPublished && task.published) || session.state === "closing" || session.state === "closed") {
      throw new Error(`task_cancelled: ${task.taskId} no longer owns session ${session.record.sessionId}`);
    }
  }

  #timeoutResult(ids: readonly string[]): WaitResult {
    const completed = ids.map((id) => this.#tasks.get(id)!).filter(isPublishedTerminal);
    const terminal = new Set(completed.map((task) => task.taskId));
    return { completed: completed.map(toTaskResult), pending: ids.filter((id) => !terminal.has(id)), timed_out: true };
  }

  #background(session: ResidentSession, operation: Promise<void>): void {
    void operation.catch((error: unknown) => {
      session.state = "error";
      this.#options.logger?.(`Pi session ${session.record.sessionId} background failure: ${errorMessage(error)}\n`);
    });
  }

  #assertProcessCapacity(): void {
    const active = [...this.#sessions.values()].filter((session) => session.process?.processOwned).length;
    if (active >= this.#options.maxSessions) throw new Error(`session_limit: maximum ${this.#options.maxSessions} active Pi processes reached`);
  }

  #enterAdmission(): () => void {
    this.#assertAvailable();
    let release!: () => void;
    const token = new Promise<void>((resolveToken) => { release = resolveToken; });
    this.#admissions.add(token);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      this.#admissions.delete(token);
      release();
    };
  }

  #assertAvailable(): void {
    if (this.#shuttingDown) throw new Error("server_shutting_down");
  }
}

function isKnownTerminal(task: TaskRecord): task is TaskRecord & { status: StoredTaskStatus; completedAt: string } {
  return terminalStatuses.has(task.status) && task.completedAt !== undefined;
}

function setKnownTerminal(
  task: TaskRecord,
  status: StoredTaskStatus,
  detail: { response?: string; error?: string },
): void {
  task.status = status;
  task.completedAt ??= new Date().toISOString();
  if (detail.response !== undefined) task.response = detail.response;
  if (detail.error !== undefined) task.error = detail.error;
}

function createTask(taskId: string, sessionId: string, generation: number): TaskRecord {
  return { taskId, sessionId, generation, status: "dispatching", published: false, finalizing: false, promptAccepted: false, pendingSettled: false, finalizationPromise: undefined };
}

function interruptedTask(taskId: string, sessionId: string, error: string): StoredTask {
  return { taskId, sessionId, status: "host_interrupted", error, completedAt: new Date().toISOString() };
}

function toStoredTask(task: TaskRecord): StoredTask {
  if (!terminalStatuses.has(task.status) || !task.completedAt) throw new Error(`task_not_terminal: ${task.taskId}`);
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    status: task.status as StoredTaskStatus,
    ...(task.response !== undefined ? { response: task.response } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    completedAt: task.completedAt,
  };
}

function fromStoredTask(task: StoredTask, generation: number): TaskRecord {
  return { ...task, generation, published: true, finalizing: false, promptAccepted: true, pendingSettled: false, finalizationPromise: undefined };
}

function isPublishedTerminal(task: TaskRecord): task is TaskRecord & { status: StoredTaskStatus; completedAt: string } {
  return task.published && terminalStatuses.has(task.status) && task.completedAt !== undefined;
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

function toSessionStatus(session: ResidentSession): SessionStatus {
  const record = session.record;
  return {
    session_id: record.sessionId,
    ...(record.name ? { name: record.name } : {}),
    cwd: record.cwd,
    ...(record.model ? { model: record.model } : {}),
    state: session.state,
    resident: session.process?.processOwned ?? false,
    recoverable: record.recoverable,
    current_task_id: record.activeTaskId,
    ...(record.lastTask ? { last_task: storedTaskResult(record.lastTask) } : {}),
    ...(record.piSessionId ? { pi_session_id: record.piSessionId } : {}),
    ...(record.sessionFile ? { session_file: record.sessionFile } : {}),
    ...(session.activeTask?.persistenceError ? { persistence_error: session.activeTask.persistenceError } : {}),
  };
}

function storedTaskResult(task: StoredTask): TaskResult {
  return { session_id: task.sessionId, task_id: task.taskId, status: task.status, ...(task.response !== undefined ? { response: task.response } : {}), ...(task.error !== undefined ? { error: task.error } : {}) };
}

function toRuntimeState(state: SessionRecordV2["state"]): SessionState {
  if (state === "creating") return "dispatching";
  if (state === "migration_blocked") return "error";
  return state;
}

async function ensureExclusiveEmptyDirectory(path: string): Promise<void> {
  await ensurePrivateDirectory(path);
  if ((await readdir(path)).length !== 0) throw new Error(`session_directory_not_empty: ${path}`);
}

function validateNewState(sessionId: string, sessionFile: string | null, expectedId: string, directory: string): string {
  if (sessionId !== expectedId) throw new Error(`session_native_mismatch: expected ${expectedId}, got ${sessionId}`);
  if (!sessionFile || !isAbsolute(sessionFile)) throw new Error("Pi RPC did not provide an absolute intended session file");
  const absolute = resolve(sessionFile);
  if (dirname(absolute) !== resolve(directory)) throw new Error(`session_path_outside_exclusive_directory: ${absolute}`);
  return absolute;
}

async function assertPathMissing(path: string): Promise<void> {
  await assertNoSymlinkComponents(path, { allowMissing: true });
  try {
    await lstat(path);
    throw new Error(`session_file_exists_before_prompt: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function isExclusiveSessionPath(root: string, sessionId: string, path: string): boolean {
  const directory = join(root, "pi-sessions", sessionRecordHash(sessionId));
  return isAbsolute(path) && dirname(resolve(path)) === resolve(directory);
}

async function assertIdentityUnchanged(identity: PiSessionIdentity): Promise<PiSessionIdentity> {
  const fresh = await readPiSessionIdentity(identity.path);
  if (fresh.sessionId !== identity.sessionId || fresh.device !== identity.device || fresh.inode !== identity.inode) {
    throw new Error(`session_identity_changed: ${identity.path}`);
  }
  return fresh;
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
  return resolve(cwd);
}

function isAssistantFailureStop(stopReason: string | undefined): boolean {
  return stopReason !== undefined && ["error", "aborted", "cancelled", "canceled"].includes(stopReason.toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
