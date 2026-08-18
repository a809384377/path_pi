import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlDecoder } from "../src/rpc/jsonl.js";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: unknown;
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached before timeout");
}

function assertProcessGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0));
}

test("stdio EOF performs clean bounded shutdown of server, Pi, and tool child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-stdio-"));
  const stateDirectory = join(directory, "state");
  const fixture = join(process.cwd(), "test", "fixtures", "fake-pi.mjs");
  const server = spawn(process.execPath, [join(process.cwd(), "dist", "src", "index.js")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_AGENT_MCP_STATE_DIR: stateDirectory,
      PI_AGENT_MCP_PI_EXECUTABLE: fixture,
      PI_AGENT_MCP_SHUTDOWN_GRACE_MS: "100",
      PI_AGENT_MCP_COMMAND_TIMEOUT_MS: "3000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new JsonlDecoder();
  const responses = new Map<number, JsonRpcResponse>();
  let stderr = "";
  server.stdout.on("data", (chunk: Buffer) => {
    for (const line of decoder.push(chunk)) {
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id !== undefined) responses.set(message.id, message);
    }
  });
  server.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString("utf8"));

  let requestId = 0;
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const id = ++requestId;
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await waitFor(() => responses.get(id), 3_000);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  };

  try {
    await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stdio-e2e", version: "0.1.0" },
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const spawnResult = await request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "spawn-tool-child", cwd: directory },
    }) as { content: Array<{ text: string }> };
    const spawned = JSON.parse(spawnResult.content[0]!.text) as { task_id: string };
    await request("tools/call", {
      name: "pi_wait",
      arguments: { task_ids: [spawned.task_id], mode: "all", timeout_seconds: 1 },
    });

    const stateFile = await waitFor(() =>
      readdir(directory).then((names) => names.find((name) => name.startsWith(".fake-pi-state-"))),
    );
    const state = JSON.parse(await readFile(join(directory, stateFile), "utf8")) as { pid: number; toolChildPid: number };
    assert.ok(state.toolChildPid);
    const serverPid = server.pid!;
    server.stdin.end();
    const exit = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        server.once("exit", (code, signal) => resolve({ code, signal })),
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`server did not exit; stderr=${stderr}`)), 2_000)),
    ]);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assertProcessGone(serverPid);
    assertProcessGone(state.pid);
    assertProcessGone(state.toolChildPid);
    const manifest = JSON.parse(await readFile(join(stateDirectory, "sessions.json"), "utf8"));
    assert.equal(manifest.cleanShutdown, true);
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  }
});
