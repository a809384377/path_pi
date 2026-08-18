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
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
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
  #closed = false;
  #stderr = "";
  #exitPromise: Promise<void> | undefined;
  #resolveExit: (() => void) | undefined;

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
    return this.#child !== undefined && !this.#closed;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get stderrTail(): string {
    return this.#stderr;
  }

  async start(): Promise<PiSessionState> {
    if (this.#child !== undefined) throw new Error("Pi RPC process has already been started");
    this.#closed = false;
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
    child.stdout.on("end", () => this.#consumeLines(this.#decoder.end()));
    child.stderr.on("data", (chunk: Buffer | string) => this.#captureStderr(chunk));
    child.once("error", (error) => this.#handleTermination(error));
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#handleTermination(new Error(`Pi RPC process exited with ${detail}`));
    });

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

  abort(): Promise<void> {
    return this.#send<void>({ type: "abort" }).then(() => undefined);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    if (this.#closed) {
      await this.#exitPromise;
      return;
    }

    this.#closed = true;
    this.#rejectPending(new Error("Pi RPC process stopped"));
    this.#killProcessTree("SIGTERM");

    const exited = this.#exitPromise ?? Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.#options.shutdownGraceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (this.#child !== undefined) {
      this.#killProcessTree("SIGKILL");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 100))]);
    }
  }

  #send<T>(command: RpcCommand): Promise<T> {
    if (this.#child === undefined || this.#closed) {
      return Promise.reject(new Error("Pi RPC process is not running"));
    }
    const id = `rpc_${++this.#requestSequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC ${command.type} timed out after ${this.#options.commandTimeoutMs}ms`));
      }, this.#options.commandTimeoutMs);
      this.#pending.set(id, {
        command: command.type,
        resolve: (response) => resolve(response.data as T),
        reject,
        timer,
      });
      const payload = `${JSON.stringify({ id, ...command })}\n`;
      this.#child!.stdin.write(payload, (error?: Error | null) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
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

      if (isRpcResponse(message)) {
        this.#handleResponse(message);
      } else if (typeof message === "object" && message !== null && typeof (message as RpcEvent).type === "string") {
        this.emit("event", message as RpcEvent);
      } else {
        this.#protocolFailure(new Error("Invalid message shape from Pi RPC"));
        return;
      }
    }
  }

  #handleResponse(response: RpcResponse): void {
    if (!response.id) {
      this.#protocolFailure(new Error(`Uncorrelated Pi RPC response for ${response.command}`));
      return;
    }
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
    this.#killProcessTree("SIGTERM");
    this.#handleTermination(error);
  }

  #handleTermination(error: Error): void {
    if (this.#child === undefined) return;
    this.#child = undefined;
    this.#closed = true;
    this.#rejectPending(error);
    this.#resolveExit?.();
    this.#resolveExit = undefined;
    this.emit("exit", error);
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
