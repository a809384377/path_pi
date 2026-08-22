import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlDecoder } from "../../npm/src/rpc/jsonl.js";
import { SessionRecordStore } from "../../npm/src/store/session-store.js";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

class StdioHost {
  readonly process: ChildProcessWithoutNullStreams;
  readonly #responses = new Map<number, JsonRpcResponse>();
  readonly #decoder = new JsonlDecoder();
  #requestId = 0;
  stderr = "";

  constructor(root: string, cwd: string, fixture: string) {
    this.process = spawn(process.execPath, [join(process.cwd(), "..", "npm", "dist", "index.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PI_AGENT_MCP_STATE_DIR: root,
        PI_AGENT_MCP_PI_EXECUTABLE: fixture,
        PI_AGENT_MCP_SHUTDOWN_GRACE_MS: "100",
        PI_AGENT_MCP_COMMAND_TIMEOUT_MS: "3000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk: Buffer) => {
      for (const line of this.#decoder.push(chunk)) {
        const message = JSON.parse(line) as JsonRpcResponse;
        if (message.id !== undefined) this.#responses.set(message.id, message);
      }
    });
    this.process.stderr.on("data", (chunk: Buffer) => this.stderr += chunk.toString("utf8"));
    void cwd;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "dual-stdio-e2e", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  notify(method: string, params: unknown): void {
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async request(method: string, params: unknown, timeoutMs = 4_000): Promise<unknown> {
    const id = ++this.#requestId;
    this.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await waitFor(() => this.#responses.get(id), timeoutMs);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  }

  async tool(name: string, args: unknown, timeoutMs = 4_000): Promise<{ value: any; isError: boolean }> {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    return { value: JSON.parse(result.content[0]!.text), isError: result.isError === true };
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.end();
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        this.process.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`stdio host did not exit: ${this.stderr}`)), 3_000)),
    ]);
    assert.equal(exit.code, 0, this.stderr);
    assert.equal(exit.signal, null, this.stderr);
  }

  kill(): void {
    if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
  }
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached before timeout");
}

test("two independent stdio servers share registry and transfer after graceful shutdown", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-dual-stdio-"));
  const root = join(directory, "state");
  const fixture = join(process.cwd(), "test", "fixtures", "fake-pi.mjs");
  const first = new StdioHost(root, directory, fixture);
  const second = new StdioHost(root, directory, fixture);
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const [firstSpawn, secondSpawn] = await Promise.all([
      first.tool("pi_spawn", { task: "stdio-first delay:1000", cwd: directory }),
      second.tool("pi_spawn", { task: "stdio-second delay:30", cwd: directory }),
    ]);
    assert.equal(firstSpawn.isError, false);
    assert.equal(secondSpawn.isError, false);
    const firstSession = firstSpawn.value as { session_id: string; task_id: string };
    const secondSession = secondSpawn.value as { session_id: string; task_id: string };

    const status = await second.tool("pi_status", { session_id: firstSession.session_id });
    assert.equal(status.value.current_task_id, firstSession.task_id);
    assert.equal(status.value.resident, "unknown");
    const contention = await second.tool("pi_send", { session_id: firstSession.session_id, task: "blocked" });
    assert.equal(contention.isError, true);
    assert.deepEqual(contention.value, { error: "session_in_use" });

    const [firstWait, secondWait, remoteWait] = await Promise.all([
      first.tool("pi_wait", { task_ids: [firstSession.task_id], mode: "all" }),
      second.tool("pi_wait", { task_ids: [secondSession.task_id], mode: "all" }),
      second.tool("pi_wait", { task_ids: [firstSession.task_id], mode: "all" }),
    ]);
    assert.match(firstWait.value.completed[0].response, /stdio-first/);
    assert.match(secondWait.value.completed[0].response, /stdio-second/);
    assert.equal(remoteWait.value.completed[0].task_id, firstSession.task_id);
    assert.equal((await new SessionRecordStore(root).list()).length, 2);

    await first.close();
    const takeover = await second.tool("pi_send", { session_id: firstSession.session_id, task: "stdio-takeover" });
    assert.equal(takeover.isError, false);
    const takeoverWait = await second.tool("pi_wait", {
      task_ids: [takeover.value.task_id],
      mode: "all",
    });
    assert.match(takeoverWait.value.completed[0].response, /stdio-first delay:1000\|stdio-takeover/);
    const closed = await second.tool("pi_close", { session_id: firstSession.session_id });
    assert.equal(closed.value.state, "closed");
    await second.close();
  } finally {
    first.kill();
    second.kill();
  }
});
