import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { OwnershipLockManager } from "../src/ownership/session-ownership.js";
import { PiRpcProcess, type PiRpcProcessOptions } from "../src/rpc/pi-rpc-process.js";
import type { PiSessionState } from "../src/rpc/types.js";
import { SessionManager } from "../src/session/session-manager.js";
import { sessionRecordHash, SessionRecordStore, type SessionRecordV2 } from "../src/store/session-store.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-pi.mjs");
const now = "2026-08-18T00:00:00.000Z";

class ControlledRpc extends PiRpcProcess {
  readonly options: PiRpcProcessOptions;
  readonly sessionId: string;
  readonly sessionFile: string;
  promptCount = 0;
  switchCount = 0;
  lastText = "controlled-result";
  owned = false;
  autoSettle = true;

  constructor(options: PiRpcProcessOptions) {
    super(options);
    this.options = options;
    const startup = options.startup!;
    if (startup.kind === "new") {
      this.sessionId = startup.sessionId;
      this.sessionFile = join(startup.sessionDirectory, `session-${startup.sessionId}.jsonl`);
    } else if (startup.kind === "restore") {
      this.sessionFile = startup.sessionFile;
      this.sessionId = "native-controlled";
    } else {
      throw new Error("controlled RPC requires explicit startup");
    }
  }

  override async start(): Promise<PiSessionState> {
    this.owned = true;
    if (this.options.startup?.kind === "restore") {
      const header = JSON.parse((await readFile(this.sessionFile, "utf8")).split("\n")[0]!) as { id: string };
      (this as { sessionId: string }).sessionId = header.id;
    }
    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      isStreaming: false,
      isCompacting: false,
      messageCount: 0,
      pendingMessageCount: 0,
    };
  }

  override async prompt(): Promise<void> {
    this.promptCount += 1;
    await mkdir(dirname(this.sessionFile), { recursive: true });
    await writeFile(this.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: this.sessionId, cwd: this.options.cwd })}\n`);
    if (this.autoSettle) queueMicrotask(() => this.emit("event", { type: "agent_settled" }));
  }
  override async getLastAssistantText(): Promise<{ text: string }> { return { text: this.lastText }; }
  override async switchSession(): Promise<{ cancelled: boolean }> { this.switchCount += 1; return { cancelled: false }; }
  override async abort(): Promise<void> {}
  override async stop(): Promise<void> { this.owned = false; }
  override get running(): boolean { return this.owned; }
  override get processOwned(): boolean { return this.owned; }
}

class DelayedStartRpc extends ControlledRpc {
  readonly entered: Promise<void>;
  #markEntered!: () => void;
  #release!: () => void;
  readonly #gate: Promise<void>;

  constructor(options: PiRpcProcessOptions) {
    super(options);
    this.entered = new Promise((resolve) => { this.#markEntered = resolve; });
    this.#gate = new Promise((resolve) => { this.#release = resolve; });
  }
  override async start(): Promise<PiSessionState> {
    this.#markEntered();
    await this.#gate;
    return super.start();
  }
  release(): void { this.#release(); }
}

class SettledThenRejectedRpc extends ControlledRpc {
  override async prompt(): Promise<void> {
    this.promptCount += 1;
    await mkdir(dirname(this.sessionFile), { recursive: true });
    await writeFile(this.sessionFile, `${JSON.stringify({ type: "session", version: 3, id: this.sessionId, cwd: this.options.cwd })}\n`);
    this.emit("event", { type: "agent_settled" });
    throw new Error("prompt rejected");
  }
}

class FailingRecordStore extends SessionRecordStore {
  failNextUpdate = false;
  failUpdateCount = 0;
  override async updateOwned(...args: Parameters<SessionRecordStore["updateOwned"]>): Promise<void> {
    if (this.failNextUpdate || this.failUpdateCount > 0) {
      this.failNextUpdate = false;
      this.failUpdateCount = Math.max(0, this.failUpdateCount - 1);
      throw new Error("disk full");
    }
    return super.updateOwned(...args);
  }
}

class DeferredGate {
  readonly entered: Promise<void>;
  readonly wait: Promise<void>;
  #markEntered!: () => void;
  #release!: () => void;
  constructor() {
    this.entered = new Promise((resolve) => { this.#markEntered = resolve; });
    this.wait = new Promise((resolve) => { this.#release = resolve; });
  }
  async block(): Promise<void> { this.#markEntered(); await this.wait; }
  release(): void { this.#release(); }
}

class GatedReadStore extends SessionRecordStore {
  readGate: DeferredGate | undefined;
  override async read(...args: Parameters<SessionRecordStore["read"]>): Promise<SessionRecordV2> {
    const gate = this.readGate;
    if (gate) {
      this.readGate = undefined;
      await gate.block();
    }
    return super.read(...args);
  }
}

class GatedUpdateStore extends SessionRecordStore {
  updateGate: DeferredGate | undefined;
  override async updateOwned(...args: Parameters<SessionRecordStore["updateOwned"]>): Promise<void> {
    const gate = this.updateGate;
    if (gate) {
      this.updateGate = undefined;
      await gate.block();
    }
    return super.updateOwned(...args);
  }
}

class GatedOwnershipLockManager extends OwnershipLockManager {
  sessionGate: DeferredGate | undefined;
  override async acquireSession(...args: Parameters<OwnershipLockManager["acquireSession"]>) {
    const gate = this.sessionGate;
    if (gate) {
      this.sessionGate = undefined;
      await gate.block();
    }
    return super.acquireSession(...args);
  }
}

class SettleDuringAbortRpc extends ControlledRpc {
  override async abort(): Promise<void> {
    this.emit("event", { type: "agent_settled" });
  }
}

class InvalidSessionFileRpc extends ControlledRpc {
  override async prompt(): Promise<void> {
    this.promptCount += 1;
    await mkdir(dirname(this.sessionFile), { recursive: true });
    await writeFile(this.sessionFile, "{invalid\n");
    queueMicrotask(() => this.emit("event", { type: "agent_settled" }));
  }
}

class UnconfirmedExitRpc extends ControlledRpc {
  override async stop(): Promise<void> { throw new Error("exit not confirmed"); }
  override get processOwned(): boolean { return this.owned; }
  confirmExit(): void {
    this.owned = false;
    this.emit("exit", new Error("late confirmed exit"));
  }
}

interface Harness {
  root: string;
  cwd: string;
  store: SessionRecordStore;
  locks: OwnershipLockManager;
  manager: SessionManager;
}

async function harness(options: Partial<Parameters<typeof createManager>[2]> = {}): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-v2-"));
  const root = join(cwd, "state");
  const store = new SessionRecordStore(root);
  const locks = new OwnershipLockManager(root);
  const manager = await createManager(store, locks, {
    executable: fixture,
    commandTimeoutMs: 3_000,
    shutdownGraceMs: 100,
    ...options,
  });
  return { root, cwd, store, locks, manager };
}

async function createManager(
  store: SessionRecordStore,
  locks: OwnershipLockManager,
  options: Omit<PiRpcProcessOptions, "cwd"> & {
    rpcFactory?: (options: PiRpcProcessOptions) => PiRpcProcess;
    idFactory?: () => string;
    nativeIdFactory?: () => string;
  } = {},
): Promise<SessionManager> {
  let sequence = 0;
  const manager = new SessionManager({
    store,
    ownership: locks,
    idFactory: options.idFactory ?? (() => String(++sequence)),
    nativeIdFactory: options.nativeIdFactory ?? (() => `native-${++sequence}`),
    ...(options.executable ? { executable: options.executable } : {}),
    ...(options.commandTimeoutMs ? { commandTimeoutMs: options.commandTimeoutMs } : {}),
    ...(options.shutdownGraceMs ? { shutdownGraceMs: options.shutdownGraceMs } : {}),
    ...(options.rpcFactory ? { rpcFactory: options.rpcFactory } : {}),
  });
  await manager.initialize();
  return manager;
}

async function waitTerminal(manager: SessionManager, taskId: string): Promise<void> {
  const result = await manager.wait([taskId], "all", 2_000);
  assert.equal(result.completed.length, 1);
}

async function writePiFile(path: string, id: string, cwd: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n`);
}

function record(root: string, sessionId: string, overrides: Partial<SessionRecordV2> = {}): SessionRecordV2 {
  return {
    version: 2,
    sessionId,
    revision: 1,
    generation: 1,
    cwd: dirname(root),
    piSessionId: "native-controlled",
    state: "dormant",
    recoverable: true,
    activeTaskId: null,
    updatedAt: now,
    ...overrides,
  };
}

test("shutdown closes admission and waits a blocked send before cleaning its process", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-admission-read-"));
  const root = join(cwd, "state");
  const store = new GatedReadStore(root);
  const sessionFile = join(cwd, "admission.jsonl");
  await writePiFile(sessionFile, "native-controlled", cwd);
  await store.create(record(root, "pi_admission", { sessionFile }));
  let rpc: ControlledRpc | undefined;
  const manager = await createManager(store, new OwnershipLockManager(root), {
    rpcFactory: (options) => {
      rpc = new ControlledRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  const gate = new DeferredGate();
  store.readGate = gate;
  const sending = manager.send("pi_admission", "work");
  await gate.entered;
  let shutdownResolved = false;
  const shuttingDown = manager.shutdown().then(() => { shutdownResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);
  gate.release();
  await sending;
  await shuttingDown;
  assert.equal(rpc!.processOwned, false);
  await assert.rejects(manager.send("pi_admission", "later"), /server_shutting_down/);
  await assert.rejects(manager.spawn({ task: "later", cwd }), /server_shutting_down/);
});

test("shutdown waits a blocked spawn ownership admission and then cleans it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-admission-lock-"));
  const root = join(cwd, "state");
  const store = new SessionRecordStore(root);
  const locks = new GatedOwnershipLockManager(root);
  let rpc: ControlledRpc | undefined;
  const manager = await createManager(store, locks, {
    rpcFactory: (options) => {
      rpc = new ControlledRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  const gate = new DeferredGate();
  locks.sessionGate = gate;
  const spawning = manager.spawn({ task: "work", cwd });
  await gate.entered;
  let shutdownResolved = false;
  const shuttingDown = manager.shutdown().then(() => { shutdownResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);
  gate.release();
  await spawning;
  await shuttingDown;
  assert.equal(rpc!.processOwned, false);
  assert.deepEqual([...manager.status()].filter((value) => value.resident), []);
});

test("restore rejects same-header inode replacement performed by rpcFactory before launch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-inode-swap-"));
  const root = join(cwd, "state");
  const store = new SessionRecordStore(root);
  const sessionFile = join(cwd, "session.jsonl");
  await writePiFile(sessionFile, "native-controlled", cwd);
  await store.create(record(root, "pi_inode_swap", { sessionFile }));
  let rpc: ControlledRpc | undefined;
  const manager = await createManager(store, new OwnershipLockManager(root), {
    rpcFactory: (options) => {
      const replacement = `${sessionFile}.replacement`;
      writeFileSync(
        replacement,
        `${JSON.stringify({ type: "session", version: 3, id: "native-controlled", cwd })}\n${JSON.stringify({ type: "different-history" })}\n`,
      );
      renameSync(replacement, sessionFile);
      rpc = new ControlledRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  await assert.rejects(manager.send("pi_inode_swap", "must-not-dispatch"), /session_identity_changed/);
  assert.equal(rpc!.promptCount, 0);
  assert.equal(rpc!.processOwned, false);
  await manager.shutdown();
});

test("SessionManager runs three v2 sessions concurrently without crossing results", async () => {
  const h = await harness();
  const [a, b, c] = await Promise.all([
    h.manager.spawn({ task: "A delay:45", cwd: h.cwd }),
    h.manager.spawn({ task: "B delay:10", cwd: h.cwd }),
    h.manager.spawn({ task: "C delay:25", cwd: h.cwd }),
  ]);
  const all = await h.manager.wait([a.task_id, b.task_id, c.task_id], "all", 2_000);
  assert.equal(all.completed.length, 3);
  assert.match(all.completed.find((task) => task.task_id === a.task_id)?.response ?? "", /reply:A/);
  assert.match(all.completed.find((task) => task.task_id === c.task_id)?.response ?? "", /reply:C/);
  await h.manager.shutdown();
});

test("new startup owns logical/native before prompt and passes exact startup/fds", async () => {
  let rpc: ControlledRpc | undefined;
  const h = await harness({ rpcFactory: (options) => {
    rpc = new ControlledRpc(options);
    rpc.autoSettle = false;
    return rpc;
  } });
  const task = await h.manager.spawn({ task: "work", cwd: h.cwd, model: "provider/model" });
  assert.equal(rpc!.options.startup?.kind, "new");
  assert.equal(rpc!.options.ownershipFds?.length, 2);
  assert.ok(rpc!.options.ownershipFds!.every((fd) => Number.isInteger(fd) && fd > 2));
  assert.equal(rpc!.promptCount, 1);
  const stored = await h.store.read(task.session_id);
  assert.equal(stored.state, "running");
  assert.equal(stored.recoverable, false);
  rpc!.emit("event", { type: "agent_settled" });
  await waitTerminal(h.manager, task.task_id);
  assert.equal((await h.store.read(task.session_id)).recoverable, true);
  await h.manager.shutdown();
});

test("restore uses direct --session startup and never switch_session", async () => {
  const first = await harness();
  const spawned = await first.manager.spawn({ task: "first", cwd: first.cwd });
  await waitTerminal(first.manager, spawned.task_id);
  await first.manager.shutdown();

  let restored: ControlledRpc | undefined;
  const second = await createManager(first.store, new OwnershipLockManager(first.root), {
    rpcFactory: (options) => (restored = new ControlledRpc(options)),
  });
  const sent = await second.send(spawned.session_id, "second");
  assert.equal(restored!.options.startup?.kind, "restore");
  assert.equal(restored!.switchCount, 0);
  await waitTerminal(second, sent.task_id);
  await second.shutdown();
});

test("second manager is fenced while resident owner holds locks and takes over after graceful shutdown", async () => {
  const first = await harness();
  const spawned = await first.manager.spawn({ task: "first", cwd: first.cwd });
  await waitTerminal(first.manager, spawned.task_id);
  const second = await createManager(first.store, new OwnershipLockManager(first.root), { executable: fixture, commandTimeoutMs: 3_000, shutdownGraceMs: 100 });
  await assert.rejects(second.send(spawned.session_id, "blocked"), /session_in_use/);
  await assert.rejects(second.close(spawned.session_id), /session_in_use/);
  await first.manager.shutdown();
  const taken = await second.send(spawned.session_id, "second");
  const result = await second.wait([taken.task_id], "all", 2_000);
  assert.match(result.completed[0]?.response ?? "", /reply:first\|second/);
  await second.shutdown();
});

test("actual-native alias is fenced even under a different logical record", async () => {
  const first = await harness();
  const spawned = await first.manager.spawn({ task: "first", cwd: first.cwd });
  await waitTerminal(first.manager, spawned.task_id);
  const original = await first.store.read(spawned.session_id);
  const alias = { ...original, sessionId: "pi_alias", revision: 1, generation: 1, activeTaskId: null, updatedAt: now };
  delete alias.lastTask;
  await first.store.create(alias);
  const second = await createManager(first.store, new OwnershipLockManager(first.root));
  await assert.rejects(second.send("pi_alias", "work"), /native_session_in_use/);
  await first.manager.shutdown();
  await second.shutdown();
});

test("free established running record is safely interrupted before direct restore", async () => {
  const h = await harness();
  const sessionId = "pi_stale_established";
  const sessionFile = join(h.cwd, "stale-established.jsonl");
  await writePiFile(sessionFile, "native-controlled", h.cwd);
  await h.store.create(record(h.root, sessionId, {
    sessionFile,
    state: "running",
    recoverable: true,
    activeTaskId: "task_stale_established",
  }));
  let rpc: ControlledRpc | undefined;
  const manager = await createManager(h.store, new OwnershipLockManager(h.root), {
    rpcFactory: (options) => {
      rpc = new ControlledRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  const sent = await manager.send(sessionId, "next");
  assert.equal(rpc!.options.startup?.kind, "restore");
  const during = await h.store.read(sessionId);
  assert.equal(during.lastTask?.taskId, "task_stale_established");
  assert.equal(during.lastTask?.status, "host_interrupted");
  assert.equal(during.activeTaskId, sent.task_id);
  await manager.close(sessionId);
  await manager.shutdown();
});

test("terminal result remains durable when the new Pi file header is invalid", async () => {
  const h = await harness({ rpcFactory: (options) => new InvalidSessionFileRpc(options) });
  const spawned = await h.manager.spawn({ task: "work", cwd: h.cwd });
  const result = await h.manager.wait([spawned.task_id], "all", 2_000);
  assert.equal(result.completed[0]?.status, "completed");
  const stored = await h.store.read(spawned.session_id);
  assert.equal(stored.lastTask?.taskId, spawned.task_id);
  assert.equal(stored.state, "error");
  assert.equal(stored.recoverable, false);
  await h.manager.close(spawned.session_id);
  await h.manager.shutdown();
});

test("recoverable:false crash reconciliation interrupts valid file and restores", async () => {
  const h = await harness();
  const sessionId = "pi_reconcile";
  const sessionDirectory = join(h.root, "pi-sessions", sessionRecordHash(sessionId));
  const sessionFile = join(sessionDirectory, "session-native-controlled.jsonl");
  await writePiFile(sessionFile, "native-controlled", h.cwd);
  await h.store.create(record(h.root, sessionId, {
    sessionFile,
    state: "running",
    recoverable: false,
    activeTaskId: "task_stale",
  }));
  let rpc: ControlledRpc | undefined;
  const manager = await createManager(h.store, new OwnershipLockManager(h.root), {
    rpcFactory: (options) => {
      rpc = new ControlledRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  const sent = await manager.send(sessionId, "next");
  const during = await h.store.read(sessionId);
  assert.equal(during.lastTask?.taskId, "task_stale");
  assert.equal(during.lastTask?.status, "host_interrupted");
  assert.equal(during.activeTaskId, sent.task_id);
  await manager.close(sessionId);
  await manager.shutdown();
});

test("invalid recoverable:false crash record becomes error without Pi start", async () => {
  const h = await harness();
  const sessionId = "pi_invalid_reconcile";
  const sessionDirectory = join(h.root, "pi-sessions", sessionRecordHash(sessionId));
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  const missing = join(sessionDirectory, "missing.jsonl");
  await h.store.create(record(h.root, sessionId, {
    sessionFile: missing,
    state: "running",
    recoverable: false,
    activeTaskId: "task_stale",
  }));
  let starts = 0;
  const manager = await createManager(h.store, new OwnershipLockManager(h.root), {
    rpcFactory: (options) => { starts += 1; return new ControlledRpc(options); },
  });
  await assert.rejects(manager.send(sessionId, "next"), /session_not_recoverable/);
  assert.equal(starts, 0);
  const failed = await h.store.read(sessionId);
  assert.equal(failed.state, "error");
  assert.equal(failed.recoverable, false);
  assert.equal(failed.lastTask?.status, "host_interrupted");
  await manager.shutdown();
});

test("free remote running close publishes host_interrupted and closed without Pi", async () => {
  const h = await harness();
  const sessionId = "pi_remote_close";
  const sessionFile = join(h.cwd, "remote.jsonl");
  await writePiFile(sessionFile, "native-controlled", h.cwd);
  await h.store.create(record(h.root, sessionId, {
    sessionFile,
    state: "running",
    activeTaskId: "task_remote",
  }));
  let starts = 0;
  const manager = await createManager(h.store, new OwnershipLockManager(h.root), {
    rpcFactory: (options) => { starts += 1; return new ControlledRpc(options); },
  });
  const status = await manager.close(sessionId);
  assert.equal(starts, 0);
  assert.equal(status.state, "closed");
  const closed = await h.store.read(sessionId);
  assert.equal(closed.lastTask?.status, "host_interrupted");
  assert.equal(closed.activeTaskId, null);
  await manager.shutdown();
});

test("close during delayed startup cancels prompt and releases only after confirmed stop", async () => {
  let rpc: DelayedStartRpc | undefined;
  const h = await harness({ rpcFactory: (options) => (rpc = new DelayedStartRpc(options)) });
  const spawning = h.manager.spawn({ task: "work", cwd: h.cwd });
  while (!rpc) await new Promise((resolve) => setTimeout(resolve, 1));
  await rpc.entered;
  const sessionId = h.manager.status()[0]!.session_id;
  const closing = h.manager.close(sessionId);
  rpc.release();
  await assert.rejects(spawning, /task_cancelled|session_file_exists|failed/);
  await closing;
  assert.equal(rpc.promptCount, 0);
  assert.equal(h.manager.status(sessionId).state, "closed");
  await h.manager.shutdown();
});

test("settled-before-rejected-prompt never publishes completion", async () => {
  const h = await harness({ rpcFactory: (options) => new SettledThenRejectedRpc(options) });
  await assert.rejects(h.manager.spawn({ task: "work", cwd: h.cwd }), /prompt rejected/);
  const status = h.manager.status()[0]!;
  assert.equal(status.last_task?.status, "failed");
  assert.doesNotMatch(status.last_task?.error ?? "", /completed/);
  await h.manager.shutdown();
});

test("shutdown drains settle finalization started by abort before its cleanup mutation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-settle-cleanup-"));
  const root = join(cwd, "state");
  const store = new GatedUpdateStore(root);
  let rpc: SettleDuringAbortRpc | undefined;
  const manager = await createManager(store, new OwnershipLockManager(root), {
    rpcFactory: (options) => {
      rpc = new SettleDuringAbortRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  const spawned = await manager.spawn({ task: "work", cwd });
  const gate = new DeferredGate();
  store.updateGate = gate;
  let shutdownResolved = false;
  const shuttingDown = manager.shutdown().then(() => { shutdownResolved = true; });
  await gate.entered;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownResolved, false);
  gate.release();
  await shuttingDown;
  const stored = await store.read(spawned.session_id);
  assert.equal(stored.lastTask?.taskId, spawned.task_id);
  assert.equal(stored.lastTask?.status, "completed");
  assert.equal(stored.lastTask?.response, "controlled-result");
  assert.equal(stored.state, "dormant");
});

test("terminal persistence failure retains ownership until cleanup durably succeeds", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-persist-fail-"));
  const root = join(cwd, "state");
  const store = new FailingRecordStore(root);
  let rpc: ControlledRpc | undefined;
  const manager = await createManager(store, new OwnershipLockManager(root), {
    rpcFactory: (options) => {
      rpc = new ControlledRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  const spawned = await manager.spawn({ task: "work", cwd });
  const waiting = manager.wait([spawned.task_id], "all", 1_000);
  store.failNextUpdate = true;
  rpc!.emit("event", { type: "agent_settled" });
  await assert.rejects(waiting, /persistence_error.*disk full/);
  const contender = new OwnershipLockManager(root);
  await assert.rejects(contender.acquire("logical", spawned.session_id), /session_in_use/);
  await manager.shutdown();
  const durable = await store.read(spawned.session_id);
  assert.equal(durable.lastTask?.taskId, spawned.task_id);
  assert.equal(durable.lastTask?.status, "completed");
  assert.equal(durable.lastTask?.response, "controlled-result");
  const acquired = await contender.acquire("logical", spawned.session_id);
  await acquired.close();
});

test("failed shutdown cleanup is retryable without reopening admission or losing terminal result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-shutdown-retry-"));
  const root = join(cwd, "state");
  const store = new FailingRecordStore(root);
  let rpc: ControlledRpc | undefined;
  const manager = await createManager(store, new OwnershipLockManager(root), {
    rpcFactory: (options) => {
      rpc = new ControlledRpc(options);
      rpc.autoSettle = false;
      return rpc;
    },
  });
  const spawned = await manager.spawn({ task: "work", cwd });
  const waiting = manager.wait([spawned.task_id], "all", 1_000);
  store.failUpdateCount = 2;
  rpc!.emit("event", { type: "agent_settled" });
  await assert.rejects(waiting, /persistence_error.*disk full/);
  await assert.rejects(manager.shutdown(), /Failed to cleanly shut down/);
  const contender = new OwnershipLockManager(root);
  await assert.rejects(contender.acquire("logical", spawned.session_id), /session_in_use/);
  await assert.rejects(manager.spawn({ task: "forbidden", cwd }), /server_shutting_down/);
  await manager.shutdown();
  const durable = await store.read(spawned.session_id);
  assert.equal(durable.lastTask?.taskId, spawned.task_id);
  assert.equal(durable.lastTask?.status, "completed");
  assert.equal(durable.lastTask?.response, "controlled-result");
  const acquired = await contender.acquire("logical", spawned.session_id);
  await acquired.close();
});

test("server SIGKILL leaves fake Pi inherited ownership until its process group exits", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-manager-host-crash-"));
  const root = join(cwd, "state");
  const hostFixture = join(process.cwd(), "test", "fixtures", "manager-host.mjs");
  const host = spawnProcess(process.execPath, [
    hostFixture,
    join(process.cwd(), "dist", "src", "session", "session-manager.js"),
    join(process.cwd(), "dist", "src", "store", "session-store.js"),
    join(process.cwd(), "dist", "src", "ownership", "session-ownership.js"),
    root,
    cwd,
    fixture,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const spawned = await new Promise<{ session_id: string }>((resolve, reject) => {
    host.once("error", reject);
    host.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline !== -1) resolve(JSON.parse(output.slice(0, newline)) as { session_id: string });
    });
  });
  let piPid = 0;
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const name = (await readdir(cwd)).find((entry) => entry.startsWith(".fake-pi-state-"));
      if (name) {
        piPid = (JSON.parse(await readFile(join(cwd, name), "utf8")) as { pid: number }).pid;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(piPid > 0);
    host.kill("SIGKILL");
    await new Promise((resolve) => host.once("exit", resolve));
    const contender = new OwnershipLockManager(root);
    await assert.rejects(contender.acquire("logical", spawned.session_id), /session_in_use/);
    process.kill(-piPid, "SIGKILL");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const acquired = await contender.acquire("logical", spawned.session_id);
        await acquired.close();
        return;
      } catch (error) {
        if (!String(error).includes("session_in_use")) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("ownership remained held after fake Pi process group exit");
  } finally {
    try { host.kill("SIGKILL"); } catch {}
    if (piPid > 0) try { process.kill(-piPid, "SIGKILL"); } catch {}
  }
});

test("unconfirmed group exit retains ownership lock", async () => {
  let rpc: UnconfirmedExitRpc | undefined;
  const h = await harness({ rpcFactory: (options) => (rpc = new UnconfirmedExitRpc(options)) });
  const spawned = await h.manager.spawn({ task: "work", cwd: h.cwd });
  await waitTerminal(h.manager, spawned.task_id);
  await assert.rejects(h.manager.shutdown(), /Failed to cleanly shut down/);
  const contender = new OwnershipLockManager(h.root);
  await assert.rejects(contender.acquire("logical", spawned.session_id), /session_in_use/);
  rpc!.confirmExit();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const acquired = await contender.acquire("logical", spawned.session_id);
      await acquired.close();
      return;
    } catch (error) {
      if (!String(error).includes("session_in_use")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("ownership was not released after late group-exit confirmation");
});

test("status is observational and does not acquire remote ownership", async () => {
  const h = await harness();
  const sessionId = "pi_status_only";
  await h.store.create(record(h.root, sessionId, { recoverable: false, state: "error" }));
  const manager = await createManager(h.store, new OwnershipLockManager(h.root));
  assert.equal(manager.status(sessionId).resident, false);
  const handle = await new OwnershipLockManager(h.root).acquire("logical", sessionId);
  await handle.close();
  await manager.shutdown();
});
