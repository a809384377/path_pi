import { execFileSync, spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonlDecoder } from "./jsonl.js";
import {
  isRpcResponse,
  type LastAssistantTextResult,
  type PiSessionState,
  type RpcCommand,
  type RpcEvent,
  type RpcResponse,
  type SwitchSessionResult,
} from "./types.js";

export interface SpawnedProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit" | "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
  readonly killed?: boolean | undefined;
  readonly pid?: number | undefined;
}

export type ProcessFactory = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => SpawnedProcess;

export interface PiRpcProcessOptions {
  cwd: string;
  executable?: string;
  model?: string;
  commandTimeoutMs?: number;
  shutdownGraceMs?: number;
  maxStderrBytes?: number;
  processFactory?: ProcessFactory;
  logger?: (message: string) => void;
}

interface PendingCommand {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const defaultProcessFactory: ProcessFactory = (command, args, options) =>
  spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;

class PosixProcessGroup {
  readonly #pgid: number;
  #released = false;
  #leaderExited = false;

  constructor(pgid: number) {
    this.#pgid = pgid;
  }

  get id(): number {
    return this.#pgid;
  }

  markLeaderExited(): void {
    this.#leaderExited = true;
  }

  alive(): boolean {
    if (this.#released) return false;
    try {
      const members = execFileSync("ps", ["-o", "pid=,stat=", "-g", String(this.#pgid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\S+)/))
        .filter((member): member is RegExpMatchArray => member !== null)
        .map((member) => ({ pid: Number(member[1]), state: member[2]! }));
      const liveMembers = members.filter((member) => !member.state.startsWith("Z"));
      if (this.#leaderExited && liveMembers.some((member) => member.pid === this.#pgid)) {
        this.#released = true;
        return false;
      }
      if (liveMembers.length > 0) return true;
      this.#released = true;
      return false;
    } catch {
      try {
        process.kill(-this.#pgid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
        this.#released = true;
        return false;
      }
    }
  }

  signal(signal: NodeJS.Signals): boolean {
    if (!this.alive()) return false;
    try {
      process.kill(-this.#pgid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") this.#released = true;
      return false;
    }
  }

  release(): void {
    this.#released = true;
  }
}

export class PiRpcProcess extends EventEmitter {
  readonly #options: Required<Pick<PiRpcProcessOptions, "executable" | "commandTimeoutMs" | "shutdownGraceMs" | "maxStderrBytes">> &
    PiRpcProcessOptions;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #decoder = new JsonlDecoder();
  #child: SpawnedProcess | undefined;
  #processGroup: PosixProcessGroup | undefined;
  #requestSequence = 0;
  #acceptingCommands = false;
  #stderr = "";
  #ownershipPromise: Promise<void> | undefined;
  #resolveOwnership: (() => void) | undefined;
  #terminationReason: Error | undefined;
  #terminationStarted: Promise<void> | undefined;
  #exitNotified = false;

  constructor(options: PiRpcProcessOptions) {
    super();
    this.#options = {
      ...options,
      executable: options.executable ?? "pi",
      commandTimeoutMs: options.commandTimeoutMs ?? 30_000,
      shutdownGraceMs: options.shutdownGraceMs ?? 1_000,
      maxStderrBytes: options.maxStderrBytes ?? 32_768,
    };
  }

  get running(): boolean {
    return this.#child !== undefined && this.#acceptingCommands;
  }

  get processOwned(): boolean {
    return this.#processGroup?.alive() ?? this.#child !== undefined;
  }

  get pid(): number | undefined {
    return this.#processGroup?.id ?? this.#child?.pid;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  async start(): Promise<PiSessionState> {
    if (this.processOwned) throw new Error("Pi RPC process has already been started");
    this.#acceptingCommands = true;
    this.#terminationReason = undefined;
    this.#terminationStarted = undefined;
    this.#exitNotified = false;
    const args = ["--mode", "rpc"];
    if (this.#options.model) args.push("--model", this.#options.model);

    const processFactory = this.#options.processFactory ?? defaultProcessFactory;
    const child = processFactory(this.#options.executable, args, {
      cwd: this.#options.cwd,
      env: process.env,
      detached: process.platform !== "win32",
    });
    this.#child = child;
    if (process.platform !== "win32" && child.pid !== undefined) this.#processGroup = new PosixProcessGroup(child.pid);
    this.#ownershipPromise = new Promise((resolve) => {
      this.#resolveOwnership = resolve;
    });

    child.stdout.on("data", (chunk: Buffer | string) => this.#consumeLines(this.#decoder.push(chunk)));
    child.stdout.on("end", () => {
      this.#consumeLines(this.#decoder.end());
      if (this.#child === child) this.#transportFailure(new Error("Pi RPC stdout ended before process exit"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => this.#captureStderr(chunk));
    child.stdin.on("error", (error: Error) => this.#transportFailure(error));
    child.once("error", (error) => this.#transportFailure(error));
    const confirmLeaderExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#leaderExited(child, this.#terminationReason ?? new Error(`Pi RPC process exited with ${detail}`));
    };
    child.once("exit", confirmLeaderExit);
    child.once("close", confirmLeaderExit);

    try {
      return await this.getState();
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  prompt(message: string): Promise<void> {
    return this.#send<void>({ type: "prompt", message }).then(() => undefined);
  }

  getState(): Promise<PiSessionState> {
    return this.#send<PiSessionState>({ type: "get_state" });
  }

  switchSession(sessionPath: string): Promise<SwitchSessionResult> {
    return this.#send<SwitchSessionResult>({ type: "switch_session", sessionPath });
  }

  getLastAssistantText(): Promise<LastAssistantTextResult> {
    return this.#send<LastAssistantTextResult>({ type: "get_last_assistant_text" });
  }

  abort(timeoutMs = this.#options.commandTimeoutMs): Promise<void> {
    return this.#send<void>({ type: "abort" }, timeoutMs).then(() => undefined);
  }

  stop(): Promise<void> {
    if (!this.processOwned) {
      this.#completeOwnership();
      return Promise.resolve();
    }
    return this.#beginTermination(new Error("Pi RPC process stopped"));
  }

  #send<T>(command: RpcCommand, timeoutMs = this.#options.commandTimeoutMs): Promise<T> {
    const child = this.#child;
    if (child === undefined || !this.#acceptingCommands) {
      return Promise.reject(new Error("Pi RPC process is not running"));
    }
    const id = `rpc_${++this.#requestSequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        command: command.type,
        resolve: (response) => resolve(response.data as T),
        reject,
        timer,
      });
      const payload = `${JSON.stringify({ id, ...command })}\n`;
      child.stdin.write(payload, (error?: Error | null) => {
        if (!error) return;
        this.#rejectCommand(id, error);
        this.#transportFailure(error);
      });
    });
  }

  #consumeLines(lines: readonly string[]): void {
    for (const line of lines) {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.#protocolFailure(new Error(`Invalid JSON from Pi RPC: ${(error as Error).message}`));
        return;
      }

      if (typeof message !== "object" || message === null || Array.isArray(message) || typeof (message as RpcEvent).type !== "string") {
        this.#protocolFailure(new Error("Invalid message shape from Pi RPC"));
        return;
      }
      if ((message as RpcEvent).type === "response") {
        if (!isRpcResponse(message)) {
          this.#protocolFailure(new Error("Invalid Pi RPC response shape"));
          return;
        }
        this.#handleResponse(message);
      } else {
        this.emit("event", message as RpcEvent);
      }
    }
  }

  #handleResponse(response: RpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      this.#protocolFailure(new Error(`Unknown Pi RPC response id ${response.id}`));
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.command !== pending.command) {
      pending.reject(new Error(`Pi RPC response command mismatch: expected ${pending.command}, got ${response.command}`));
    } else if (!response.success) {
      pending.reject(new Error(response.error ?? `Pi RPC ${response.command} failed`));
    } else {
      pending.resolve(response);
    }
  }

  #protocolFailure(error: Error): void {
    this.emit("protocolError", error);
    this.#transportFailure(error);
  }

  #transportFailure(error: Error): void {
    if (!this.processOwned) return;
    this.#acceptingCommands = false;
    this.#terminationReason ??= error;
    this.#rejectPending(this.#terminationReason);
    void this.#beginTermination(this.#terminationReason).catch((stopError: unknown) => {
      this.#options.logger?.(`Failed to terminate Pi RPC process: ${errorMessage(stopError)}\n`);
    });
  }

  #beginTermination(reason: Error): Promise<void> {
    if (!this.processOwned) {
      this.#completeOwnership();
      return Promise.resolve();
    }
    if (this.#terminationStarted) return this.#terminationStarted;
    this.#acceptingCommands = false;
    this.#terminationReason ??= reason;
    this.#rejectPending(this.#terminationReason);
    this.#terminationStarted = this.#terminateOwnedProcess();
    return this.#terminationStarted;
  }

  async #terminateOwnedProcess(): Promise<void> {
    const ownershipPromise = this.#ownershipPromise;
    if (!ownershipPromise) return;
    const startedAt = Date.now();
    const termBudgetMs = Math.max(1, Math.floor(this.#options.shutdownGraceMs / 2));
    this.#signalOwnedTree("SIGTERM");
    if (await this.#waitForOwnershipRelease(termBudgetMs)) return;
    this.#signalOwnedTree("SIGKILL");
    const remainingMs = Math.max(1, this.#options.shutdownGraceMs - (Date.now() - startedAt));
    if (await this.#waitForOwnershipRelease(remainingMs)) return;
    throw new Error(`Pi process group ${this.pid ?? "unknown"} did not exit after SIGKILL`);
  }

  async #waitForOwnershipRelease(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.processOwned) {
        this.#completeOwnership();
        return true;
      }
      await delay(Math.min(5, Math.max(1, deadline - Date.now())));
    }
    if (!this.processOwned) {
      this.#completeOwnership();
      return true;
    }
    return false;
  }

  #leaderExited(child: SpawnedProcess, error: Error): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#processGroup?.markLeaderExited();
    this.#acceptingCommands = false;
    this.#terminationReason ??= error;
    this.#rejectPending(this.#terminationReason);
    if (!this.processOwned) {
      this.#completeOwnership();
      return;
    }
    void this.#beginTermination(this.#terminationReason).catch((stopError: unknown) => {
      this.#options.logger?.(`Failed to terminate Pi process group: ${errorMessage(stopError)}\n`);
    });
  }

  #completeOwnership(): void {
    if (this.processOwned) return;
    this.#processGroup?.release();
    this.#processGroup = undefined;
    this.#child = undefined;
    this.#acceptingCommands = false;
    this.#resolveOwnership?.();
    this.#resolveOwnership = undefined;
    if (!this.#exitNotified) {
      this.#exitNotified = true;
      this.emit("exit", this.#terminationReason ?? new Error("Pi RPC process exited"));
    }
  }

  #rejectCommand(id: string, error: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #captureStderr(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.#stderr = (this.#stderr + text).slice(-this.#options.maxStderrBytes);
    this.#options.logger?.(text);
  }

  #signalOwnedTree(signal: NodeJS.Signals): void {
    if (this.#processGroup) {
      this.#processGroup.signal(signal);
      return;
    }
    try {
      this.#child?.kill(signal);
    } catch {}
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
