import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServerRuntime, resolveServerConfiguration, startupErrorMessage } from "../../npm/src/server.js";
import { SessionRecordStore, sessionRecordHash, type SessionRecordV2 } from "../../npm/src/store/session-store.js";
import type { SessionManifest, StoredSession } from "../../npm/src/store/legacy-session-store.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-pi.mjs");
const now = "2026-08-18T00:00:00.000Z";

function runtimeEnv(root?: string): NodeJS.ProcessEnv {
  return {
    ...(root ? { PI_AGENT_MCP_STATE_DIR: root } : {}),
    PI_AGENT_MCP_PI_EXECUTABLE: fixture,
    PI_AGENT_MCP_COMMAND_TIMEOUT_MS: "3000",
    PI_AGENT_MCP_SHUTDOWN_GRACE_MS: "100",
  };
}

async function waitTerminal(runtime: Awaited<ReturnType<typeof createServerRuntime>>, taskId: string) {
  const result = await runtime.manager.wait([taskId], "all");
  assert.equal(result.completed.length, 1);
  return result.completed[0]!;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function legacySession(sessionId: string, cwd: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId,
    generation: 1,
    cwd,
    state: "error",
    activeTaskId: null,
    ...overrides,
  };
}

async function writeLegacyManifest(path: string, manifest: SessionManifest): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function v2Record(sessionId: string, cwd: string): SessionRecordV2 {
  return {
    version: 2,
    sessionId,
    revision: 1,
    generation: 1,
    cwd,
    state: "error",
    recoverable: false,
    activeTaskId: null,
    updatedAt: now,
  };
}

test("startup ownership and migration diagnostics are actionable and path-safe", () => {
  const ownership = startupErrorMessage(new Error("ownership_unavailable: unsafe lock file: /secret/locks/logical.lock"));
  assert.match(ownership, /Node >=22\.19 <26/);
  assert.doesNotMatch(ownership, /\/secret|logical\.lock/);
  const migration = startupErrorMessage(new Error("migration_backup_mismatch: /secret/legacy/sessions.json"));
  assert.match(migration, /migration_blocked/);
  assert.doesNotMatch(migration, /\/secret|sessions\.json/);
});

test("known caller-specific root startup diagnostics give ordered upgrade guidance", () => {
  const message = startupErrorMessage(new Error(
    "legacy_state_uncertain: caller-specific legacy state root configured; stop all old clients, remove PI_AGENT_MCP_STATE_DIR, then start one canonical v2 client",
  ));
  assert.match(message, /remove PI_AGENT_MCP_STATE_DIR.*canonical v2 client.*migration receipts.*other clients/);
});

test("factory resolves one canonical default root and keeps explicit roots isolated", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-server-config-home-"));
  assert.equal(resolveServerConfiguration({}, home).stateRoot, join(home, ".pi", "agent-mcp"));
  assert.equal(resolveServerConfiguration({}, home).canonical, true);

  const isolated = join(home, "isolated");
  const configuration = resolveServerConfiguration({ PI_AGENT_MCP_STATE_DIR: isolated }, home);
  assert.equal(configuration.stateRoot, isolated);
  assert.equal(configuration.canonical, false);
});

test("canonical factory resumes and imports clean legacy sources before serving", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-server-migrate-home-"));
  const legacyRoot = join(home, ".pi", "agent-mcp-claude");
  const source = join(legacyRoot, "sessions.json");
  await writeLegacyManifest(source, {
    version: 1,
    cleanShutdown: true,
    sessions: { pi_legacy: legacySession("pi_legacy", home) },
  });

  const runtime = await createServerRuntime(runtimeEnv(), home);
  try {
    assert.equal(runtime.stateRoot, join(home, ".pi", "agent-mcp"));
    assert.equal(runtime.migrationOutcomes.some((outcome) => outcome.status === "migrated"), true);
    assert.equal((await runtime.manager.status("pi_legacy")).session_id, "pi_legacy");
    await assert.rejects(access(source));
    const migrations = await readdir(join(runtime.stateRoot, "migrations"));
    assert.equal(migrations.length, 1);
    await access(join(runtime.stateRoot, "migrations", migrations[0]!, "receipt.json"));
    for (const directory of ["sessions", "pi-sessions", "locks", "migrations", "tmp"]) {
      assert.equal((await lstat(join(runtime.stateRoot, directory))).mode & 0o077, 0);
    }
  } finally {
    await runtime.manager.shutdown();
  }
});

test("explicit factory root never consolidates legacy sources", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-server-isolated-home-"));
  const source = join(home, ".pi", "agent-mcp-codex", "sessions.json");
  await writeLegacyManifest(source, {
    version: 1,
    cleanShutdown: true,
    sessions: { pi_legacy: legacySession("pi_legacy", home) },
  });
  const isolated = join(home, "isolated");
  const runtime = await createServerRuntime(runtimeEnv(isolated), home);
  try {
    assert.deepEqual(runtime.migrationOutcomes, []);
    await access(source);
    assert.deepEqual(await runtime.manager.status(), []);
  } finally {
    await runtime.manager.shutdown();
  }
});

test("canonical startup reports dirty uncertainty and accepts one-time attestation", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-server-dirty-home-"));
  const source = join(home, ".pi", "agent-mcp-claude", "sessions.json");
  await writeLegacyManifest(source, {
    version: 1,
    cleanShutdown: false,
    sessions: { pi_dirty: legacySession("pi_dirty", home, { state: "running", activeTaskId: "task_dirty" }) },
  });
  await assert.rejects(createServerRuntime(runtimeEnv(), home), /legacy_state_uncertain/);

  const runtime = await createServerRuntime({ ...runtimeEnv(), PI_AGENT_MCP_IMPORT_DIRTY: "1" }, home);
  try {
    const status = await runtime.manager.status("pi_dirty");
    assert.equal(status.last_task?.task_id, "task_dirty");
    assert.equal(status.last_task?.status, "host_interrupted");
  } finally {
    await runtime.manager.shutdown();
  }
});

test("canonical startup turns source conflicts into migration_conflict", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-server-conflict-home-"));
  const root = join(home, ".pi", "agent-mcp");
  const store = new SessionRecordStore(root);
  await store.create(v2Record("pi_conflict", home));
  const source = join(home, ".pi", "agent-mcp-codex", "sessions.json");
  await writeLegacyManifest(source, {
    version: 1,
    cleanShutdown: true,
    sessions: { pi_conflict: legacySession("pi_conflict", "/tmp") },
  });

  await assert.rejects(createServerRuntime(runtimeEnv(), home), /migration_conflict/);
  await access(source);
});

test("independent runtimes share records, status, waits, takeover, contention, and close", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-server-shared-"));
  const root = join(directory, "state");
  const first = await createServerRuntime(runtimeEnv(root), directory);
  const second = await createServerRuntime(runtimeEnv(root), directory);
  try {
    const [fromFirst, fromSecond] = await Promise.all([
      first.manager.spawn({ task: "first delay:300", cwd: directory }),
      second.manager.spawn({ task: "second delay:25", cwd: directory }),
    ]);

    const seenBySecond = await second.manager.status(fromFirst.session_id);
    assert.equal(seenBySecond.resident, "unknown");
    assert.equal(seenBySecond.ownership, "other");
    assert.equal(seenBySecond.current_task_id, fromFirst.task_id);
    const remoteWaitAbort = new AbortController();
    const cancelledRemoteWait = second.manager.wait([fromFirst.task_id], "all", remoteWaitAbort.signal);
    await waitFor(() => second.manager.listenerCount("taskTerminal") === 1);
    remoteWaitAbort.abort(new Error("cancel remote wait"));
    await assert.rejects(cancelledRemoteWait, /cancel remote wait/);
    assert.equal(second.manager.listenerCount("taskTerminal"), 0);
    assert.equal(second.manager.listenerCount("taskPersistenceError"), 0);
    const remoteWait = second.manager.wait([fromFirst.task_id], "all");
    await assert.rejects(second.manager.send(fromFirst.session_id, "blocked"), /session_in_use/);

    const [firstResult, secondResult, remoteResult] = await Promise.all([
      waitTerminal(first, fromFirst.task_id),
      waitTerminal(second, fromSecond.task_id),
      remoteWait,
    ]);
    assert.match(firstResult.response ?? "", /reply:first/);
    assert.match(secondResult.response ?? "", /reply:second/);
    assert.equal(remoteResult.completed[0]?.task_id, fromFirst.task_id);
    const repeatLast = await second.manager.wait([fromFirst.task_id], "all");
    assert.equal(repeatLast.completed[0]?.task_id, fromFirst.task_id);
    assert.equal((await new SessionRecordStore(root).list()).length, 2);

    const localStatus = await first.manager.status(fromFirst.session_id);
    assert.equal(localStatus.resident, true);
    assert.equal(localStatus.ownership, "local");
    await first.manager.shutdown();

    const takeover = await second.manager.send(fromFirst.session_id, "after-shutdown");
    const takeoverResult = await waitTerminal(second, takeover.task_id);
    assert.match(takeoverResult.response ?? "", /reply:first delay:300\|after-shutdown/);
    await second.manager.shutdown();

    const closer = await createServerRuntime(runtimeEnv(root), directory);
    try {
      const closed = await closer.manager.close(fromFirst.session_id);
      assert.equal(closed.state, "closed");
      assert.equal((await closer.manager.status(fromFirst.session_id)).state, "closed");
    } finally {
      await closer.manager.shutdown();
    }
  } finally {
    await first.manager.shutdown().catch(() => undefined);
    await second.manager.shutdown().catch(() => undefined);
  }
});

test("status rejects corrupt final records and factory repairs no unsafe modes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-server-corrupt-status-"));
  const root = join(directory, "state");
  const runtime = await createServerRuntime(runtimeEnv(root), directory);
  try {
    await writeFile(join(root, "sessions", "corrupt.json"), "{broken\n", { mode: 0o600 });
    await assert.rejects(runtime.manager.status(), /Invalid session record/);
    await chmod(root, 0o755);
    await assert.rejects(createServerRuntime(runtimeEnv(root), directory), /permissions must be 0700/);
  } finally {
    await chmod(root, 0o700);
    await runtime.manager.shutdown();
  }
});

test("remote wait reports pending, reconciles free active records, and forgets overwritten task ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-server-remote-wait-"));
  const root = join(directory, "state");
  const store = new SessionRecordStore(root);
  const sessionId = "pi_remote_wait";
  const sessionDirectory = join(root, "pi-sessions", "unused");
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await store.create({
    ...v2Record(sessionId, directory),
    piSessionId: "native-remote-wait",
    state: "creating",
    activeTaskId: "task_current",
  });
  const runtime = await createServerRuntime(runtimeEnv(root), directory);
  try {
    const reconciled = await runtime.manager.wait(["task_current"], "all");
    assert.equal(reconciled.completed[0]?.status, "host_interrupted");
    const current = await store.read(sessionId);
    assert.equal(current.state, "error");
    assert.equal(current.activeTaskId, null);

    await store.updateOwned(sessionId, current.revision, {
      ...current,
      revision: current.revision + 1,
      generation: current.generation + 1,
      lastTask: {
        taskId: "task_newer",
        sessionId,
        status: "completed",
        response: "newer",
        completedAt: now,
      },
      updatedAt: now,
    });
    await assert.rejects(runtime.manager.wait(["task_current"], "all"), /unknown_task/);
  } finally {
    await runtime.manager.shutdown();
  }
});

test("known caller-specific legacy roots reject explicit v2 startup with upgrade guidance", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-server-known-legacy-home-"));
  for (const name of ["agent-mcp-claude", "agent-mcp-codex"]) {
    const root = join(home, ".pi", name);
    assert.throws(
      () => resolveServerConfiguration({ PI_AGENT_MCP_STATE_DIR: root }, home),
      /legacy_state_uncertain.*remove PI_AGENT_MCP_STATE_DIR.*canonical v2 client/,
    );
    await assert.rejects(createServerRuntime(runtimeEnv(root), home), /legacy_state_uncertain/);
  }
});

test("corrupt final record does not block startup or healthy session access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-server-corrupt-startup-"));
  const root = join(directory, "state");
  const store = new SessionRecordStore(root);
  await store.create(v2Record("pi_healthy", directory));
  await writeFile(join(store.sessionsDirectory, `${sessionRecordHash("pi_corrupt")}.json`), "{broken", { mode: 0o600 });
  const runtime = await createServerRuntime(runtimeEnv(root), directory);
  try {
    assert.equal((await runtime.manager.status("pi_healthy")).session_id, "pi_healthy");
    await assert.rejects(runtime.manager.status(), /Invalid session record.*sessions/);
  } finally {
    await runtime.manager.shutdown();
  }
});
