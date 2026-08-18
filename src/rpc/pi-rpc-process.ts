import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
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

export class PiRpcProcess extends EventEmitter {
  readonly #options: Required<Pick<PiRpcProcessOptions, "executable" | "commandTimeoutMs" | "shutdownGraceMs" | "maxStderrBytes">> &
    PiRpcProcessOptions;
  readonly #pending = new Map<string, PendingCommand>();
  readonly #decoder = new JsonlDecoder();
  #child: SpawnedProcess | undefined;
  #requestSequence = 0;
  #acceptingCommands = false;
  #stderr = "";
  #exitPromise: Promise<void> | undefined;
  #resolveExit: (() => void) | undefined;
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
    return this.#child !== undefined;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  async start(): Promise<PiSessionState> {
    if (this.#child !== undefined) throw new Error("Pi RPC process has already been started");
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
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    child.stdout.on("data", (chunk: Buffer | string) => this.#consumeLines(this.#decoder.push(chunk)));
    child.stdout.on("end", () => {
      this.#consumeLines(this.#decoder.end());
      if (this.#child === child) this.#transportFailure(new Error("Pi RPC stdout ended before process exit"));
    });
    child.stderr.on("data", (chunk: Buffer | string) => this.#captureStderr(chunk));
    child.stdin.on("error", (error: Error) => this.#transportFailure(error));
    child.once("error", (error) => this.#transportFailure(error));
    const confirmProcessExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#confirmExit(this.#terminationReason ?? new Error(`Pi RPC process exited with ${detail}`));
    };
    child.once("exit", confirmProcessExit);
    child.once("close", confirmProcessExit);

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
    if (this.#child === undefined) return Promise.resolve();
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
    if (this.#child === undefined) return;
    this.#acceptingCommands = false;
    this.#terminationReason ??= error;
    this.#rejectPending(this.#terminationReason);
    void this.#beginTermination(this.#terminationReason).catch((stopError: unknown) => {
      this.#options.logger?.(`Failed to terminate Pi RPC process: ${errorMessage(stopError)}\n`);
    });
  }

  #beginTermination(reason: Error): Promise<void> {
    if (this.#child === undefined) return Promise.resolve();
    if (this.#terminationStarted) return this.#terminationStarted;
    this.#acceptingCommands = false;
    this.#terminationReason ??= reason;
    this.#rejectPending(this.#terminationReason);
    this.#terminationStarted = this.#terminateOwnedProcess();
    return this.#terminationStarted;
  }

  async #terminateOwnedProcess(): Promise<void> {
    const exitPromise = this.#exitPromise;
    if (!exitPromise || this.#child === undefined) return;
    const startedAt = Date.now();
    const termBudgetMs = Math.max(1, Math.floor(this.#options.shutdownGraceMs / 2));
    this.#killProcessTree("SIGTERM");
    if (await waitFor(exitPromise, termBudgetMs)) return;
    this.#killProcessTree("SIGKILL");
    const remainingMs = Math.max(1, this.#options.shutdownGraceMs - (Date.now() - startedAt));
    if (await waitFor(exitPromise, remainingMs)) return;
    throw new Error(`Pi RPC process ${this.#child?.pid ?? "unknown"} did not exit after SIGKILL`);
  }

  #confirmExit(error: Error): void {
    if (this.#child === undefined) return;
    this.#child = undefined;
    this.#acceptingCommands = false;
    this.#terminationReason ??= error;
    this.#rejectPending(this.#terminationReason);
    this.#resolveExit?.();
    this.#resolveExit = undefined;
    if (!this.#exitNotified) {
      this.#exitNotified = true;
      this.emit("exit", this.#terminationReason);
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

  #killProcessTree(signal: NodeJS.Signals): void {
    const child = this.#child;
    if (!child) return;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {}
    }
    try {
      child.kill(signal);
    } catch {}
  }
}

async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = Symbol("timed-out");
  const result = await Promise.race([
    promise.then(() => undefined),
    new Promise<symbol>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result !== timedOut;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
