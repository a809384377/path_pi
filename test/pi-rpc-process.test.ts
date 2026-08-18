import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { PiRpcProcess, type SpawnedProcess } from "../src/rpc/pi-rpc-process.js";

class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  readonly killed = false;
  writes: Record<string, unknown>[] = [];

  constructor() {
    super();
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        this.writes.push(JSON.parse(line));
        index = buffer.indexOf("\n");
      }
    });
  }

  kill(): boolean {
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  respond(index: number, command: string, data: unknown): void {
    const request = this.writes[index]!;
    this.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command, success: true, data })}\n`);
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}

test("PiRpcProcess performs readiness correlation and emits events", async () => {
  const child = new FakeChild();
  const rpc = new PiRpcProcess({ cwd: "/tmp", processFactory: () => child, commandTimeoutMs: 100 });
  const start = rpc.start();
  await waitFor(() => child.writes.length === 1);
  assert.equal(child.writes[0]?.type, "get_state");
  child.respond(0, "get_state", {
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    messageCount: 0,
    pendingMessageCount: 0,
  });
  assert.equal((await start).sessionId, "session-1");

  const eventPromise = new Promise<string>((resolve) => rpc.once("event", (event) => resolve(event.type)));
  child.stdout.write('{"type":"agent_');
  child.stdout.write('settled"}\n');
  assert.equal(await eventPromise, "agent_settled");
  await rpc.stop();
});

test("PiRpcProcess rejects pending commands on child crash", async () => {
  const child = new FakeChild();
  const rpc = new PiRpcProcess({ cwd: "/tmp", processFactory: () => child, commandTimeoutMs: 500 });
  const start = rpc.start();
  await waitFor(() => child.writes.length === 1);
  child.respond(0, "get_state", {
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
    isStreaming: false,
    isCompacting: false,
    messageCount: 0,
    pendingMessageCount: 0,
  });
  await start;
  const prompt = rpc.prompt("work");
  child.emit("exit", 23, null);
  await assert.rejects(prompt, /exited with code 23/);
});

test("PiRpcProcess surfaces malformed JSON as a protocol failure", async () => {
  const child = new FakeChild();
  const rpc = new PiRpcProcess({ cwd: "/tmp", processFactory: () => child, commandTimeoutMs: 500 });
  const start = rpc.start();
  await waitFor(() => child.writes.length === 1);
  child.stdout.write("not-json\n");
  await assert.rejects(start, /Invalid JSON from Pi RPC/);
});
