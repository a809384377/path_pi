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
  killSignals: Array<NodeJS.Signals | number | undefined> = [];
  autoExit = true;

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

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    if (this.autoExit) queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
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

test("PiRpcProcess emits exact new/restore args and inherited stdio before commands", async () => {
  for (const [startup, expectedArgs] of [
    [
      { kind: "new" as const, sessionDirectory: "/tmp/exclusive", sessionId: "native-1" },
      ["--session-dir", "/tmp/exclusive", "--session-id", "native-1", "--mode", "rpc", "--model", "provider/model"],
    ],
    [
      { kind: "restore" as const, sessionFile: "/tmp/session.jsonl" },
      ["--session", "/tmp/session.jsonl", "--mode", "rpc", "--model", "provider/model"],
    ],
  ] as const) {
    const child = new FakeChild();
    let capturedArgs: readonly string[] = [];
    let capturedStdio: unknown;
    const rpc = new PiRpcProcess({
      cwd: "/tmp",
      startup,
      model: "provider/model",
      ownershipFds: [41, 42],
      processFactory: (_command, args, options) => {
        capturedArgs = args;
        capturedStdio = options.stdio;
        return child;
      },
      commandTimeoutMs: 100,
    });
    const starting = rpc.start();
    await waitFor(() => child.writes.length === 1);
    assert.deepEqual(capturedArgs, expectedArgs);
    assert.deepEqual(capturedStdio, ["pipe", "pipe", "pipe", 41, 42]);
    assert.deepEqual(child.writes.map((request) => request.type), ["get_state"]);
    child.respond(0, "get_state", {
      sessionFile: startup.kind === "new" ? "/tmp/exclusive/session.jsonl" : "/tmp/session.jsonl",
      sessionId: "native-1",
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
    });
    await starting;
    await rpc.stop();
  }
});

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

test("PiRpcProcess rejects malformed response shapes immediately", async () => {
  const child = new FakeChild();
  const rpc = new PiRpcProcess({ cwd: "/tmp", processFactory: () => child, commandTimeoutMs: 5_000 });
  const start = rpc.start();
  await waitFor(() => child.writes.length === 1);
  const request = child.writes[0]!;
  child.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: "get_state" })}\n`);
  await assert.rejects(start, /Invalid Pi RPC response shape/);
});

test("PiRpcProcess keeps ownership through protocol TERM and confirms KILL exit", async () => {
  const child = new FakeChild();
  child.autoExit = false;
  const rpc = new PiRpcProcess({ cwd: "/tmp", processFactory: () => child, commandTimeoutMs: 500, shutdownGraceMs: 5 });
  const start = rpc.start();
  await waitFor(() => child.writes.length === 1);
  child.stdout.write("not-json\n");
  await assert.rejects(start, /Invalid JSON from Pi RPC/);
  await waitFor(() => child.killSignals.includes("SIGKILL"));
  assert.equal(rpc.processOwned, true);
  child.emit("exit", null, "SIGKILL");
  await rpc.stop();
  assert.equal(rpc.processOwned, false);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("PiRpcProcess fails stop when OS exit cannot be confirmed", async () => {
  const child = new FakeChild();
  child.autoExit = false;
  const rpc = new PiRpcProcess({ cwd: "/tmp", processFactory: () => child, commandTimeoutMs: 500, shutdownGraceMs: 2 });
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
  await assert.rejects(rpc.stop(), /did not exit after SIGKILL/);
  assert.equal(rpc.processOwned, true);
  child.emit("exit", null, "SIGKILL");
});

test("PiRpcProcess handles stdin EPIPE and exit as one termination", async () => {
  const child = new FakeChild();
  const rpc = new PiRpcProcess({ cwd: "/tmp", processFactory: () => child, commandTimeoutMs: 500, shutdownGraceMs: 5 });
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
  let exitCount = 0;
  rpc.on("exit", () => exitCount += 1);
  const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  child.stdin.emit("error", epipe);
  child.emit("exit", 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exitCount, 1);
  assert.equal(rpc.processOwned, false);
});
