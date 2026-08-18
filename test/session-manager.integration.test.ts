import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRpcProcess } from "../src/rpc/pi-rpc-process.js";
import type { PiSessionState } from "../src/rpc/types.js";
import { SessionManager } from "../src/session/session-manager.js";
import { JsonSessionStore } from "../src/store/session-store.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-pi.mjs");

class ControlledRpc extends PiRpcProcess {
  readonly sessionFile: string;
  lastText = "controlled-result";
  promptCount = 0;

  constructor(cwd: string) {
    super({ cwd });
    this.sessionFile = join(cwd, "controlled-session.jsonl");
  }

  override async start(): Promise<PiSessionState> {
    return {
      sessionFile: this.sessionFile,
      sessionId: "controlled-session",
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }

  override async prompt(): Promise<void> {
    this.promptCount += 1;
  }
  override async getLastAssistantText(): Promise<{ text: string }> {
    return { text: this.lastText };
  }
  override async abort(): Promise<void> {}
  override async stop(): Promise<void> {}
  override get running(): boolean {
    return true;
  }
}

class SettledThenRejectedRpc extends ControlledRpc {
  override async prompt(): Promise<void> {
    this.promptCount += 1;
    this.emit("event", { type: "agent_settled" });
    throw new Error("Pi RPC prompt timed out after 5ms");
  }
}

class DelayedStartRpc extends ControlledRpc {
  readonly #started: Promise<void>;
  #releaseStart!: () => void;

  constructor(cwd: string) {
    super(cwd);
    this.#started = new Promise((resolve) => {
      this.#releaseStart = resolve;
    });
  }

  override async start(): Promise<PiSessionState> {
    await this.#started;
    return super.start();
  }

  releaseStart(): void {
    this.#releaseStart();
  }
}

class DeferredCleanupRpc extends ControlledRpc {
  readonly #stopped: Promise<void>;
  readonly stopEntered: Promise<void>;
  #releaseStop!: () => void;
  #markStopEntered!: () => void;
  stopCalls = 0;

  constructor(cwd: string) {
    super(cwd);
    this.#stopped = new Promise((resolve) => {
      this.#releaseStop = resolve;
    });
    this.stopEntered = new Promise((resolve) => {
      this.#markStopEntered = resolve;
    });
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1;
    this.#markStopEntered();
    await this.#stopped;
  }

  releaseStop(): void {
    this.#releaseStop();
  }
}

class UnconfirmedExitRpc extends ControlledRpc {
  override async stop(): Promise<void> {
    throw new Error("exit not confirmed");
  }
  override get processOwned(): boolean {
    return true;
  }
}

class GatedStore extends JsonSessionStore {
  #gate: Promise<void> | undefined;
  #releaseGate: (() => void) | undefined;
  #rejectNext: Error | undefined;

  gateNextSave(): void {
    this.#gate = new Promise((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  releaseSave(): void {
    this.#releaseGate?.();
    this.#gate = undefined;
    this.#releaseGate = undefined;
  }

  rejectNextSave(error: Error): void {
    this.#rejectNext = error;
  }

  override async save(manifest: Parameters<JsonSessionStore["save"]>[0]): Promise<void> {
    if (this.#rejectNext) {
      const error = this.#rejectNext;
      this.#rejectNext = undefined;
      throw error;
    }
    if (this.#gate) await this.#gate;
    return super.save(manifest);
  }
}

interface Harness {
  manager: SessionManager;
  directory: string;
  storePath: string;
}

async function readStateWithToolPid(path: string): Promise<{ pid: number; toolChildPid: number }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = JSON.parse(await readFile(path, "utf8")) as { pid: number; toolChildPid?: number };
    if (state.toolChildPid) return { pid: state.pid, toolChildPid: state.toolChildPid };
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("fake Pi did not record its tool child PID");
}

async function createHarness(directory?: string): Promise<Harness> {
  const cwd = directory ?? (await mkdtemp(join(tmpdir(), "pi-agent-manager-")));
  const storePath = join(cwd, "state", "sessions.json");
  let sequence = 0;
  const manager = new SessionManager({
    store: new JsonSessionStore(storePath),
    executable: fixture,
    commandTimeoutMs: 3_000,
    shutdownGraceMs: 100,
    idFactory: () => String(++sequence),
  });
  await manager.initialize();
  return { manager, directory: cwd, storePath };
}

test("SessionManager runs three sessions concurrently without crossing results", async () => {
  const { manager, directory } = await createHarness();
  const [first, second, third] = await Promise.all([
    manager.spawn({ task: "A delay:45", cwd: directory }),
    manager.spawn({ task: "B delay:10", cwd: directory }),
    manager.spawn({ task: "C delay:25", cwd: directory }),
  ]);

  const any = await manager.wait([first.task_id, second.task_id, third.task_id], "any", 500);
  assert.deepEqual(any.completed.map((task) => task.task_id), [second.task_id]);
  const all = await manager.wait([first.task_id, second.task_id, third.task_id], "all", 500);
  assert.equal(all.completed.length, 3);
  assert.match(all.completed.find((task) => task.task_id === first.task_id)?.response ?? "", /reply:A delay:45/);
  assert.match(all.completed.find((task) => task.task_id === third.task_id)?.response ?? "", /reply:C delay:25/);
  await manager.shutdown();
});

test("SessionManager serializes concurrent sends and preserves context", async () => {
  const { manager, directory } = await createHarness();
  const initial = await manager.spawn({ task: "first", cwd: directory, name: "worker" });
  await manager.wait([initial.task_id], "all", 500);

  const results = await Promise.allSettled([
    manager.send(initial.session_id, "second delay:20"),
    manager.send(initial.session_id, "third"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const dispatched = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof manager.send>>> => result.status === "fulfilled")!;
  const done = await manager.wait([dispatched.value.task_id], "all", 500);
  assert.match(done.completed[0]?.response ?? "", /reply:first\|second delay:20/);
  await manager.shutdown();
});

test("SessionManager wait supports timeout and multiple non-consuming waiters", async () => {
  const { manager, directory } = await createHarness();
  const task = await manager.spawn({ task: "slow delay:60", cwd: directory });
  const timedOut = await manager.wait([task.task_id], "any", 1);
  assert.equal(timedOut.timed_out, true);
  assert.deepEqual(timedOut.pending, [task.task_id]);

  const [first, second] = await Promise.all([
    manager.wait([task.task_id], "all", 500),
    manager.wait([task.task_id], "all", 500),
  ]);
  assert.deepEqual(first.completed, second.completed);
  const repeated = await manager.wait([task.task_id], "any", 0);
  assert.equal(repeated.timed_out, false);
  await manager.shutdown();
});

test("SessionManager marks child crash failed and keeps other sessions alive", async () => {
  const { manager, directory } = await createHarness();
  const crash = await manager.spawn({ task: "CRASH", cwd: directory });
  const healthy = await manager.spawn({ task: "healthy delay:25", cwd: directory });
  const results = await manager.wait([crash.task_id, healthy.task_id], "all", 500);
  assert.equal(results.completed.find((task) => task.task_id === crash.task_id)?.status, "failed");
  assert.equal(results.completed.find((task) => task.task_id === healthy.task_id)?.status, "completed");
  await manager.shutdown();
});

test("SessionManager close aborts exactly once and wakes waiters", async () => {
  const { manager, directory } = await createHarness();
  const task = await manager.spawn({ task: "long delay:200", cwd: directory });
  const waiting = manager.wait([task.task_id], "all", 500);
  await manager.close(task.session_id);
  const result = await waiting;
  assert.equal(result.completed[0]?.status, "aborted");
  assert.equal(manager.status(task.session_id).state, "closed");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal((await manager.wait([task.task_id], "all", 0)).completed[0]?.status, "aborted");
  await manager.shutdown();
});

test("SessionManager close wins against a late agent_settled event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  let controlled: ControlledRpc | undefined;
  const manager = new SessionManager({
    store: new JsonSessionStore(join(directory, "sessions.json")),
    rpcFactory: () => (controlled = new ControlledRpc(directory)),
  });
  await manager.initialize();
  const task = await manager.spawn({ task: "work", cwd: directory });
  await manager.close(task.session_id);
  controlled!.emit("event", { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await manager.wait([task.task_id], "all", 0)).completed[0]?.status, "aborted");
  await manager.shutdown();
});

test("SessionManager close cancels a dispatch still waiting for startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  let controlled: DelayedStartRpc | undefined;
  const manager = new SessionManager({
    store: new JsonSessionStore(join(directory, "sessions.json")),
    rpcFactory: () => (controlled = new DelayedStartRpc(directory)),
  });
  await manager.initialize();
  const spawning = manager.spawn({ task: "work", cwd: directory });
  for (let attempt = 0; attempt < 100 && !controlled; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(controlled);
  const session = manager.status()[0]!;
  await manager.close(session.session_id);
  controlled.releaseStart();
  await assert.rejects(spawning, /task_cancelled/);
  assert.equal(controlled.promptCount, 0);
  assert.equal(manager.status(session.session_id).state, "closed");
  await manager.shutdown();
});

test("SessionManager reports Pi assistant provider errors as failed", async () => {
  const { manager, directory } = await createHarness();
  const task = await manager.spawn({ task: "assistant-error", cwd: directory });
  const result = await manager.wait([task.task_id], "all", 500);
  assert.equal(result.completed[0]?.status, "failed");
  assert.match(result.completed[0]?.error ?? "", /provider authentication failed/);
  await manager.shutdown();
});

test("SessionManager does not publish settled before rejected prompt acceptance", async () => {
  const { manager, directory } = await createHarness();
  await assert.rejects(
    manager.spawn({ task: "settle-before-response reject-prompt", cwd: directory }),
    /prompt rejected/,
  );
  const session = manager.status()[0]!;
  assert.equal(session.last_task?.status, "failed");
  assert.doesNotMatch(session.last_task?.error ?? "", /completed/);
  await manager.shutdown();
});

test("SessionManager rejects settled work when prompt acceptance times out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  const manager = new SessionManager({
    store: new JsonSessionStore(join(directory, "sessions.json")),
    rpcFactory: () => new SettledThenRejectedRpc(directory),
  });
  await manager.initialize();
  await assert.rejects(manager.spawn({ task: "work", cwd: directory }), /prompt timed out/);
  const session = manager.status()[0]!;
  assert.equal(session.last_task?.status, "failed");
  assert.match(session.last_task?.error ?? "", /prompt timed out/);
  await manager.shutdown();
});

test("SessionManager rechecks shutdown after asynchronous cwd validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  let release!: () => void;
  const cwdGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const manager = new SessionManager({
    store: new JsonSessionStore(join(directory, "sessions.json")),
    cwdValidator: async (cwd) => {
      await cwdGate;
      return cwd;
    },
  });
  await manager.initialize();
  const spawning = manager.spawn({ task: "work", cwd: directory });
  await manager.shutdown();
  release();
  await assert.rejects(spawning, /server_shutting_down/);
  assert.deepEqual(manager.status(), []);
});

test("SessionManager publishes terminal state only after durable save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  const store = new GatedStore(join(directory, "sessions.json"));
  let rpc: ControlledRpc | undefined;
  const manager = new SessionManager({ store, rpcFactory: () => (rpc = new ControlledRpc(directory)) });
  await manager.initialize();
  const task = await manager.spawn({ task: "work", cwd: directory });
  store.gateNextSave();
  rpc!.emit("event", { type: "agent_settled" });
  await new Promise((resolve) => setImmediate(resolve));
  const beforeDurable = await manager.wait([task.task_id], "any", 0);
  assert.equal(beforeDurable.timed_out, true);
  assert.deepEqual(beforeDurable.completed, []);
  await assert.rejects(manager.send(task.session_id, "next"), /session_busy/);
  const waiting = manager.wait([task.task_id], "all", 500);
  store.releaseSave();
  assert.equal((await waiting).completed[0]?.status, "completed");
  await manager.shutdown();
});

test("SessionManager keeps storage-failed terminal state unpublished and non-dispatchable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  const store = new GatedStore(join(directory, "sessions.json"));
  let rpc: ControlledRpc | undefined;
  const manager = new SessionManager({ store, rpcFactory: () => (rpc = new ControlledRpc(directory)) });
  await manager.initialize();
  const task = await manager.spawn({ task: "work", cwd: directory });
  const registeredWaiter = manager.wait([task.task_id], "all", 10);
  store.rejectNextSave(new Error("disk full"));
  rpc!.emit("event", { type: "agent_settled" });
  assert.equal((await registeredWaiter).timed_out, true);
  assert.equal((await manager.wait([task.task_id], "any", 0)).timed_out, true);
  const status = manager.status(task.session_id);
  assert.equal(status.state, "error");
  assert.equal(status.recoverable, false);
  assert.match(status.persistence_error ?? "", /disk full/);
  await assert.rejects(manager.send(task.session_id, "next"), /session_not_recoverable/);
  await assert.rejects(manager.shutdown(), /Failed to persist terminal outcome/);
});

test("SessionManager coalesces concurrent close and shutdown without reopening closed session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  let rpc: DeferredCleanupRpc | undefined;
  const storePath = join(directory, "sessions.json");
  const manager = new SessionManager({
    store: new JsonSessionStore(storePath),
    rpcFactory: () => (rpc = new DeferredCleanupRpc(directory)),
  });
  await manager.initialize();
  const task = await manager.spawn({ task: "work", cwd: directory });
  const closing = manager.close(task.session_id);
  const shuttingDown = manager.shutdown();
  await rpc!.stopEntered;
  assert.equal(rpc!.stopCalls, 1);
  rpc!.releaseStop();
  await Promise.all([closing, shuttingDown]);
  assert.equal(manager.status(task.session_id).state, "closed");
  const manifest = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(manifest.cleanShutdown, true);
  assert.equal(manifest.sessions[task.session_id].state, "closed");
});

test("SessionManager refuses clean shutdown when process exit is unconfirmed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  const storePath = join(directory, "sessions.json");
  const manager = new SessionManager({
    store: new JsonSessionStore(storePath),
    rpcFactory: () => new UnconfirmedExitRpc(directory),
  });
  await manager.initialize();
  const task = await manager.spawn({ task: "work", cwd: directory });
  await assert.rejects(manager.shutdown(), /exit not confirmed/);
  const status = manager.status(task.session_id);
  assert.equal(status.state, "error");
  assert.equal(status.recoverable, false);
  const manifest = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(manifest.cleanShutdown, false);
});

test("SessionManager starts cleanup for all sessions in parallel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  const rpcs: DeferredCleanupRpc[] = [];
  const manager = new SessionManager({
    store: new JsonSessionStore(join(directory, "sessions.json")),
    rpcFactory: () => {
      const rpc = new DeferredCleanupRpc(directory);
      rpcs.push(rpc);
      return rpc;
    },
  });
  await manager.initialize();
  await Promise.all([
    manager.spawn({ task: "one", cwd: directory }),
    manager.spawn({ task: "two", cwd: directory }),
    manager.spawn({ task: "three", cwd: directory }),
  ]);
  const shutdown = manager.shutdown();
  await Promise.all(rpcs.map((rpc) => rpc.stopEntered));
  assert.deepEqual(rpcs.map((rpc) => rpc.stopCalls), [1, 1, 1]);
  for (const rpc of rpcs) rpc.releaseStop();
  await shutdown;
});

test("SessionManager close stays bounded when abort does not respond", async () => {
  const { manager, directory } = await createHarness();
  const task = await manager.spawn({ task: "ignore-abort delay:500", cwd: directory });
  const startedAt = Date.now();
  await manager.close(task.session_id);
  assert.ok(Date.now() - startedAt < 750);
  assert.equal((await manager.wait([task.task_id], "all", 0)).completed[0]?.status, "aborted");
  await manager.shutdown();
});

test("SessionManager clean restart lazily restores session context", async () => {
  const firstHarness = await createHarness();
  const initial = await firstHarness.manager.spawn({ task: "before", cwd: firstHarness.directory });
  await firstHarness.manager.wait([initial.task_id], "all", 500);
  const beforeShutdown = firstHarness.manager.status(initial.session_id);
  const sessionFile = beforeShutdown.session_file!;
  await firstHarness.manager.shutdown();
  await access(sessionFile);

  const secondHarness = await createHarness(firstHarness.directory);
  const dormant = secondHarness.manager.status(initial.session_id);
  assert.equal(dormant.state, "dormant");
  assert.equal(dormant.resident, false);
  const continued = await secondHarness.manager.send(initial.session_id, "after");
  const result = await secondHarness.manager.wait([continued.task_id], "all", 500);
  assert.match(result.completed[0]?.response ?? "", /reply:before\|after/);
  assert.match(await readFile(join(firstHarness.directory, ".fake-pi-switches.log"), "utf8"), new RegExp(sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await secondHarness.manager.shutdown();
});

test("SessionManager shutdown interrupts active tasks and leaves a clean manifest", async () => {
  const { manager, directory, storePath } = await createHarness();
  const task = await manager.spawn({ task: "unfinished spawn-tool-child delay:500", cwd: directory });
  const waiting = manager.wait([task.task_id], "all", 1_000);
  const pidFiles = (await readdir(directory)).filter((name) => name.startsWith(".fake-pi-state-"));
  assert.equal(pidFiles.length, 1);
  const childState = await readStateWithToolPid(join(directory, pidFiles[0]!));
  try {
    await manager.shutdown();
  } finally {
    for (const pid of [childState.pid, childState.toolChildPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  assert.throws(() => process.kill(childState.pid, 0));
  assert.throws(() => process.kill(childState.toolChildPid, 0));
  assert.equal((await waiting).completed[0]?.status, "host_interrupted");
  const manifest = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(manifest.cleanShutdown, true);
  assert.equal(manifest.sessions[task.session_id].state, "dormant");
});
