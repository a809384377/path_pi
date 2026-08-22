import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { SessionRecordStore, type SessionRecordV2 } from "../../npm/src/store/session-store.js";
import type { SessionManifest, StoredSession } from "../../npm/src/store/legacy-session-store.js";
import {
  InProcessMigrationCandidateLockCoordinator,
  V1SessionMigrator,
  automaticMigrationEnabled,
  canonicalDefaultStateRoot,
  discoverLegacySources,
  migrationIdentifier,
  orderedMigrationCandidates,
  type MigrationCandidate,
  type MigrationCandidateLockCoordinator,
} from "../../npm/src/store/v1-migration.js";

const now = "2026-08-18T00:00:00.000Z";

interface Harness {
  root: string;
  sourcePath: string;
  store: SessionRecordStore;
  coordinator: InProcessMigrationCandidateLockCoordinator;
  sessionFile: string;
}

async function harness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "pi-migration-"));
  const root = join(directory, "state-v2");
  const legacyRoot = join(directory, "legacy");
  const sessionFile = join(directory, "pi-session.jsonl");
  await writeFile(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: "native-alpha", cwd: directory })}\n${JSON.stringify({ type: "message" })}\n`,
  );
  const sourcePath = join(legacyRoot, "sessions.json");
  return {
    root,
    sourcePath,
    store: new SessionRecordStore(root),
    coordinator: new InProcessMigrationCandidateLockCoordinator(),
    sessionFile,
  };
}

function storedSession(h: Harness, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId: "alpha",
    generation: 2,
    name: "worker",
    cwd: join(h.root, "project"),
    model: "test/model",
    piSessionId: "native-alpha",
    sessionFile: h.sessionFile,
    state: "idle",
    activeTaskId: null,
    lastTask: {
      taskId: "task-last",
      sessionId: "alpha",
      status: "completed",
      response: "done",
      completedAt: now,
    },
    ...overrides,
  };
}

async function writeManifest(h: Harness, cleanShutdown: boolean, sessions?: Record<string, StoredSession>): Promise<SessionManifest> {
  const manifest: SessionManifest = {
    version: 1,
    cleanShutdown,
    sessions: sessions ?? { alpha: storedSession(h) },
  };
  await writeFileEnsuringParent(h.sourcePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function migrator(h: Harness, options: ConstructorParameters<typeof V1SessionMigrator>[0] = { root: h.root, recordStore: h.store }): V1SessionMigrator {
  return new V1SessionMigrator({
    ...options,
    root: h.root,
    recordStore: h.store,
    coordinator: h.coordinator,
    now: () => now,
  });
}

test("V1SessionMigrator cleanly migrates, retires source, and reruns idempotently", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const first = await migrator(h).migrateSource(h.sourcePath);
  assert.equal(first.status, "migrated");
  if (!("retiredPath" in first)) assert.fail("missing retired path");
  await access(first.retiredPath);
  assert.equal(
    basename(first.retiredPath),
    `sessions.v1.retired-${createHash("sha256").update(await readFile(first.retiredPath)).digest("hex")}.json`,
  );
  await assert.rejects(access(h.sourcePath));

  const record = await h.store.read("alpha");
  assert.equal(record.state, "dormant");
  assert.equal(record.recoverable, true);
  assert.equal(record.lastTask?.taskId, "task-last");
  assert.equal(record.migration?.sourcePath, join(dirname(first.retiredPath), "sessions.json"));

  const second = await migrator(h).migrateSource(h.sourcePath);
  assert.equal(second.status, "already_complete");
  assert.equal((await h.store.list()).length, 1);
  const transactionDirectory = await onlyTransactionDirectory(h.root);
  for (const directory of [h.root, join(h.root, "migrations"), transactionDirectory]) {
    assert.equal((await lstat(directory)).mode & 0o077, 0);
  }
});

test("V1SessionMigrator rejects dirty sources unless explicitly attested and interrupts active task", async () => {
  const h = await harness();
  await writeManifest(h, false, {
    alpha: storedSession(h, { state: "running", activeTaskId: "task-active" }),
  });
  await assert.rejects(migrator(h).migrateSource(h.sourcePath), /legacy_state_uncertain/);
  await access(h.sourcePath);

  const outcome = await migrator(h, { root: h.root, recordStore: h.store, allowDirty: true }).migrateSource(h.sourcePath);
  assert.equal(outcome.status, "migrated");
  const migrated = await h.store.read("alpha");
  assert.equal(migrated.lastTask?.taskId, "task-active");
  assert.equal(migrated.lastTask?.status, "host_interrupted");
  assert.equal(migrated.activeTaskId, null);
});

test("V1SessionMigrator leaves the entire source live when preflight finds a conflict", async () => {
  const h = await harness();
  await writeManifest(h, true);
  await h.store.create({
    version: 2,
    sessionId: "alpha",
    revision: 1,
    generation: 1,
    cwd: "/tmp",
    state: "error",
    recoverable: false,
    activeTaskId: null,
    updatedAt: now,
  });

  const outcome = await migrator(h).migrateSource(h.sourcePath);
  assert.equal(outcome.status, "conflict");
  await access(h.sourcePath);
  assert.equal((await h.store.read("alpha")).cwd, "/tmp");
  const migrationDirectory = join(h.root, "migrations");
  const transaction = (await readdir(migrationDirectory))[0]!;
  assert.match(await readFile(join(migrationDirectory, transaction, "conflicts.json"), "utf8"), /different content/);
});

test("V1SessionMigrator rejects a source that changes after staging without retiring it", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const instance = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: {
      beforeSourceHashRecheck: async () => writeFile(h.sourcePath, '{"changed":true}\n'),
    },
  });
  await assert.rejects(instance.migrateSource(h.sourcePath), /migration_source_changed/);
  assert.equal(await readFile(h.sourcePath, "utf8"), '{"changed":true}\n');
  assert.deepEqual(await h.store.list(), []);
});

test("V1SessionMigrator resumes after a crash immediately after retirement", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const crashing = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: { afterSourceRetired: () => { throw new Error("simulated crash after retirement"); } },
  });
  await assert.rejects(crashing.migrateSource(h.sourcePath), /simulated crash/);
  await assert.rejects(access(h.sourcePath));
  assert.deepEqual(await h.store.list(), []);

  const outcomes = await migrator(h).resumeIncomplete();
  assert.equal(outcomes[0]?.status, "resumed");
  assert.equal((await h.store.read("alpha")).migration?.sourcePath, join(dirname(outcomes[0]!.retiredPath), "sessions.json"));
});

test("V1SessionMigrator accepts a revision-advanced descendant on resume without overwrite", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const crashing = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: {
      afterRecordPublished: async (sessionId) => {
        const published = await h.store.read(sessionId);
        await h.store.updateOwned(sessionId, published.revision, {
          ...published,
          revision: published.revision + 1,
          generation: published.generation + 1,
          name: "evolved",
          updatedAt: "2026-08-18T00:01:00.000Z",
        });
        throw new Error("simulated crash after evolution");
      },
    },
  });
  await assert.rejects(crashing.migrateSource(h.sourcePath), /simulated crash/);

  const resumed = await migrator(h).resumeIncomplete();
  assert.equal(resumed[0]?.status, "resumed");
  const descendant = await h.store.read("alpha");
  assert.equal(descendant.revision, 2);
  assert.equal(descendant.generation, 3);
  assert.equal(descendant.name, "evolved");
});

test("V1SessionMigrator rejects same-revision destination changes on resume", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const crashing = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: {
      afterRecordPublished: async (sessionId) => {
        const path = h.store.recordPath(sessionId);
        const published = JSON.parse(await readFile(path, "utf8")) as SessionRecordV2;
        await writeFile(path, `${JSON.stringify({ ...published, name: "tampered" }, null, 2)}\n`);
        throw new Error("simulated crash after tamper");
      },
    },
  });
  await assert.rejects(crashing.migrateSource(h.sourcePath), /simulated crash/);
  await assert.rejects(migrator(h).resumeIncomplete(), /migration_destination_conflict/);
  assert.equal((await h.store.read("alpha")).name, "tampered");
});

test("V1SessionMigrator quarantines but never activates bytes replaced after the last hash check", async () => {
  const h = await harness();
  const manifest = await writeManifest(h, true);
  const original = `${JSON.stringify(manifest, null, 2)}\n`;
  const replacement = `${JSON.stringify({ ...manifest, cleanShutdown: false }, null, 2)}\n`;
  let quarantinePath = "";
  const instance = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: {
      beforeSourceTransition: async (path) => {
        quarantinePath = path;
        const next = `${h.sourcePath}.replacement`;
        await writeFile(next, replacement);
        await rename(next, h.sourcePath);
      },
    },
  });

  await assert.rejects(instance.migrateSource(h.sourcePath), /migration_quarantined_mismatch/);
  assert.equal(await readFile(quarantinePath, "utf8"), replacement);
  const transactionDirectory = await onlyTransactionDirectory(h.root);
  assert.equal(await readFile(join(transactionDirectory, "source.json"), "utf8"), original);
  assert.deepEqual(await h.store.list(), []);
});

test("V1SessionMigrator never overwrites a competing quarantine destination", async () => {
  const h = await harness();
  await writeManifest(h, true);
  let quarantinePath = "";
  const instance = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: {
      beforeSourceTransition: async (path) => {
        quarantinePath = path;
        await writeFile(path, "competing bytes\n");
      },
    },
  });

  await assert.rejects(instance.migrateSource(h.sourcePath), /migration_quarantine_exists/);
  assert.equal(await readFile(quarantinePath, "utf8"), "competing bytes\n");
  await access(h.sourcePath);
  assert.deepEqual(await h.store.list(), []);
});

test("V1SessionMigrator rejects corrupt intent provenance and published subsets", async () => {
  for (const mutate of [
    (intent: Record<string, any>) => { intent.records[0].migration.sourceHash = "f".repeat(64); },
    (intent: Record<string, any>) => { intent.publishedSessionIds.push("not-in-staged-records"); },
    (intent: Record<string, any>) => {
      intent.records[0].name = "valid-schema-tamper";
      intent.recordPayloadHashes.alpha = createHash("sha256")
        .update(`${JSON.stringify(intent.records[0], null, 2)}\n`)
        .digest("hex");
    },
  ]) {
    const h = await harness();
    await writeManifest(h, true);
    const crashing = migrator(h, {
      root: h.root,
      recordStore: h.store,
      hooks: { afterSourceRetired: () => { throw new Error("stop after retirement"); } },
    });
    await assert.rejects(crashing.migrateSource(h.sourcePath), /stop after retirement/);
    const transactionDirectory = await onlyTransactionDirectory(h.root);
    const intentPath = join(transactionDirectory, "intent.json");
    const intent = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, any>;
    mutate(intent);
    await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

    await assert.rejects(
      migrator(h).resumeIncomplete(),
      /migration_intent_invalid|migration_staged_payload_mismatch/,
    );
    assert.deepEqual(await h.store.list(), []);
  }
});

test("V1SessionMigrator rejects torn intents and modified immutable backups", async () => {
  for (const mutate of [
    async (transaction: string) => writeFile(join(transaction, "intent.json"), "{torn"),
    async (transaction: string) => writeFile(join(transaction, "source.json"), '{"version":1,"cleanShutdown":true,"sessions":{}}\n'),
  ]) {
    const h = await harness();
    await writeManifest(h, true);
    const crashing = migrator(h, {
      root: h.root,
      recordStore: h.store,
      hooks: { afterSourceRetired: () => { throw new Error("stop after retirement"); } },
    });
    await assert.rejects(crashing.migrateSource(h.sourcePath), /stop after retirement/);
    const transaction = await onlyTransactionDirectory(h.root);
    await mutate(transaction);
    await assert.rejects(migrator(h).resumeIncomplete(), /migration_intent_invalid|migration_backup_mismatch/);
    assert.deepEqual(await h.store.list(), []);
  }
});

test("V1SessionMigrator binds intents to their transaction directory", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const crashing = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: { afterSourceRetired: () => { throw new Error("stop after retirement"); } },
  });
  await assert.rejects(crashing.migrateSource(h.sourcePath), /stop after retirement/);
  const original = await onlyTransactionDirectory(h.root);
  const renamed = join(dirname(original), `v1-${"0".repeat(64)}`);
  await rename(original, renamed);

  await assert.rejects(migrator(h).resumeIncomplete(), /migration_intent_invalid/);
  assert.deepEqual(await h.store.list(), []);
});

test("V1SessionMigrator rejects corrupt completed receipts", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const completed = await migrator(h).migrateSource(h.sourcePath);
  assert.equal(completed.status, "migrated");
  const transactionDirectory = await onlyTransactionDirectory(h.root);
  const receiptPath = join(transactionDirectory, "receipt.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.quarantinePath = "/tmp/wrong-quarantine-path";
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  await assert.rejects(migrator(h).migrateSource(h.sourcePath), /migration_receipt_incomplete|migration_receipt_invalid/);
  assert.equal((await h.store.read("alpha")).migration?.migrationId, completed.migrationId);
});

test("V1SessionMigrator rejects malformed and incomplete completed receipts", async () => {
  for (const mutate of [
    (_receipt: Record<string, unknown>) => "{torn",
    (receipt: Record<string, unknown>) => {
      receipt.publishedSessionIds = [];
      return `${JSON.stringify(receipt, null, 2)}\n`;
    },
  ]) {
    const h = await harness();
    await writeManifest(h, true);
    await migrator(h).migrateSource(h.sourcePath);
    const transactionDirectory = await onlyTransactionDirectory(h.root);
    const receiptPath = join(transactionDirectory, "receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    await writeFile(receiptPath, mutate(receipt));
    await assert.rejects(migrator(h).migrateSource(h.sourcePath), /migration_receipt_invalid|migration_receipt_incomplete/);
  }
});

test("V1SessionMigrator leaves invalid legacy tasks live", async () => {
  for (const lastTask of [
    { taskId: "", sessionId: "alpha", status: "completed", completedAt: now },
    { taskId: "task", sessionId: "alpha", status: "completed", completedAt: "not-a-date" },
    { taskId: "task", sessionId: "alpha", status: "completed", completedAt: now, response: 7 },
    { taskId: "task", sessionId: "alpha", status: "completed", completedAt: now, error: 7 },
  ]) {
    const h = await harness();
    await writeManifest(h, true, { alpha: storedSession(h, { lastTask: lastTask as any }) });
    await assert.rejects(migrator(h).migrateSource(h.sourcePath), /migration_manifest_invalid/);
    await access(h.sourcePath);
    assert.deepEqual(await h.store.list(), []);
  }
});

test("V1SessionMigrator validates every declared existing session file regardless of recoverability", async () => {
  for (const recoverable of [true, false]) {
    const h = await harness();
    await writeManifest(h, true);
    const existingFile = join(dirname(h.sessionFile), `existing-${recoverable}.jsonl`);
    await writeFile(existingFile, `${JSON.stringify({ type: "session", version: 3, id: "native-alpha", cwd: h.root })}\n`);
    await h.store.create({
      version: 2,
      sessionId: "beta",
      revision: 1,
      generation: 1,
      cwd: h.root,
      piSessionId: "native-beta",
      sessionFile: existingFile,
      state: recoverable ? "dormant" : "error",
      recoverable,
      activeTaskId: null,
      updatedAt: now,
    });
    await assert.rejects(migrator(h).migrateSource(h.sourcePath), /existing_record_identity_mismatch/);
    await access(h.sourcePath);
    assert.deepEqual((await h.store.list()).map((record) => record.sessionId), ["beta"]);
  }
});

test("V1SessionMigrator fails closed for missing or invalid non-recoverable declared files", async () => {
  for (const fileState of ["missing", "invalid"] as const) {
    const h = await harness();
    await writeManifest(h, true);
    const existingFile = join(dirname(h.sessionFile), `existing-${fileState}.jsonl`);
    if (fileState === "invalid") await writeFile(existingFile, "{broken\n");
    await h.store.create({
      version: 2,
      sessionId: "beta",
      revision: 1,
      generation: 1,
      cwd: h.root,
      piSessionId: "native-beta",
      sessionFile: existingFile,
      state: "error",
      recoverable: false,
      activeTaskId: null,
      updatedAt: now,
    });
    await assert.rejects(migrator(h).migrateSource(h.sourcePath), /pi_session_open_failed|pi_session_header_malformed/);
    await access(h.sourcePath);
    assert.deepEqual((await h.store.list()).map((record) => record.sessionId), ["beta"]);
  }
});

test("V1SessionMigrator uses a non-recoverable declared file header for native conflict detection", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const existingFile = join(dirname(h.sessionFile), "existing-native-conflict.jsonl");
  await writeFile(existingFile, `${JSON.stringify({ type: "session", version: 3, id: "native-alpha", cwd: h.root })}\n`);
  await h.store.create({
    version: 2,
    sessionId: "beta",
    revision: 1,
    generation: 1,
    cwd: h.root,
    piSessionId: "native-alpha",
    sessionFile: existingFile,
    state: "error",
    recoverable: false,
    activeTaskId: null,
    updatedAt: now,
  });

  const outcome = await migrator(h).migrateSource(h.sourcePath);
  assert.equal(outcome.status, "conflict");
  if (outcome.status !== "conflict") assert.fail("expected native conflict");
  assert.deepEqual(outcome.conflicts, ["native session native-alpha already belongs to beta"]);
  await access(h.sourcePath);
  assert.deepEqual((await h.store.list()).map((record) => record.sessionId), ["beta"]);
});

test("V1SessionMigrator rejects imported Pi path replacement after candidate locks", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const instance = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: {
      afterCandidateLocksAcquired: async () => {
        const replacement = `${h.sessionFile}.next`;
        await writeFile(replacement, `${JSON.stringify({ type: "session", version: 3, id: "native-alpha", cwd: h.root })}\n`);
        await rename(replacement, h.sessionFile);
      },
    },
  });
  await assert.rejects(instance.migrateSource(h.sourcePath), /migration_pi_identity_changed/);
  await access(h.sourcePath);
  assert.deepEqual(await h.store.list(), []);
});

test("migration candidates encode migration-source-logical-native hierarchy", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const captured: MigrationCandidate[][] = [];
  const coordinator: MigrationCandidateLockCoordinator = {
    async withCandidateLocks(candidates, operation) {
      captured.push([...candidates]);
      return operation();
    },
  };
  await new V1SessionMigrator({ root: h.root, recordStore: h.store, coordinator, now: () => now }).migrateSource(h.sourcePath);
  assert.deepEqual(captured[0]?.map((candidate) => candidate.kind), ["migration", "source", "logical", "native"]);
  assert.deepEqual(
    orderedMigrationCandidates("/tmp/source", [
      { ...(await h.store.read("alpha")), sessionId: "zeta", piSessionId: "native-z" },
      { ...(await h.store.read("alpha")), sessionId: "alpha", piSessionId: "native-a" },
    ]).map((candidate) => `${candidate.kind}:${candidate.key}`),
    ["migration:v1", "source:/tmp/source", "logical:alpha", "logical:zeta", "native:native-a", "native:native-z"],
  );
});

test("V1SessionMigrator rejects symlinked source, migrations directory, and final artifacts", async () => {
  {
    const h = await harness();
    await writeManifest(h, true);
    const realSource = `${h.sourcePath}.real`;
    await rename(h.sourcePath, realSource);
    await symlink(realSource, h.sourcePath);
    await assert.rejects(migrator(h).migrateSource(h.sourcePath), /unsafe_path|unsafe_source/);
  }
  {
    const parent = await mkdtemp(join(tmpdir(), "pi-migration-parent-"));
    const external = await mkdtemp(join(tmpdir(), "pi-migration-source-external-"));
    await writeFile(join(external, "sessions.json"), "{}\n");
    await symlink(external, join(parent, "alias"));
    const h = await harness();
    await assert.rejects(
      migrator(h).migrateSource(join(parent, "alias", "sessions.json")),
      /unsafe_path: symlink component/,
    );
  }
  {
    const parent = await mkdtemp(join(tmpdir(), "pi-migration-root-parent-"));
    const external = await mkdtemp(join(tmpdir(), "pi-migration-root-external-"));
    await mkdir(join(external, "state"), { mode: 0o700 });
    await symlink(external, join(parent, "alias"));
    const h = await harness();
    await assert.rejects(
      new V1SessionMigrator({
        root: join(parent, "alias", "state"),
        recordStore: h.store,
        coordinator: h.coordinator,
      }).resumeIncomplete(),
      /unsafe_path: symlink component/,
    );
  }
  {
    const h = await harness();
    const external = await mkdtemp(join(tmpdir(), "pi-migration-external-"));
    await mkdir(h.root, { mode: 0o700 });
    await symlink(external, join(h.root, "migrations"));
    await assert.rejects(migrator(h).resumeIncomplete(), /unsafe_path/);
  }
  {
    const h = await harness();
    await mkdir(h.root, { mode: 0o700 });
    const migrations = join(h.root, "migrations");
    await mkdir(migrations, { mode: 0o700 });
    const externalTransaction = await mkdtemp(join(tmpdir(), "pi-migration-transaction-external-"));
    await symlink(externalTransaction, join(migrations, `v1-${"0".repeat(64)}`));
    await assert.rejects(migrator(h).resumeIncomplete(), /unsafe_path/);
  }
  {
    const h = await harness();
    await writeManifest(h, true);
    const crashing = migrator(h, {
      root: h.root,
      recordStore: h.store,
      hooks: { afterSourceRetired: () => { throw new Error("stop after retirement"); } },
    });
    await assert.rejects(crashing.migrateSource(h.sourcePath), /stop after retirement/);
    const transaction = await onlyTransactionDirectory(h.root);
    const intentPath = join(transaction, "intent.json");
    const external = join(dirname(transaction), "external-intent.json");
    await writeFile(external, await readFile(intentPath));
    await unlink(intentPath);
    await symlink(external, intentPath);
    await assert.rejects(migrator(h).resumeIncomplete(), /unsafe_path|unsafe_file_open|unsafe_file_identity/);
  }
});

test("automatic migration rejects symlinked or non-private canonical roots", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-migration-home-"));
  const piRoot = join(home, ".pi");
  await mkdir(piRoot, { mode: 0o700 });
  const external = await mkdtemp(join(tmpdir(), "pi-migration-home-external-"));
  const canonical = canonicalDefaultStateRoot(home);
  await symlink(external, canonical);
  assert.equal(automaticMigrationEnabled(canonical, {}, home), false);
  await unlink(canonical);
  await mkdir(canonical, { mode: 0o700 });
  assert.equal(automaticMigrationEnabled(canonical, {}, home), true);
  await chmod(canonical, 0o755);
  assert.equal(automaticMigrationEnabled(canonical, {}, home), false);
  assert.equal((await lstat(canonical)).isSymbolicLink(), false);
});

test("V1SessionMigrator requires an injected coordinator and validates native identity", async () => {
  const h = await harness();
  await writeManifest(h, true);
  await assert.rejects(
    new V1SessionMigrator({ root: h.root, recordStore: h.store }).migrateSource(h.sourcePath),
    /ownership_unavailable/,
  );

  await writeManifest(h, true, { alpha: storedSession(h, { piSessionId: "wrong-native" }) });
  await assert.rejects(migrator(h).migrateSource(h.sourcePath), /migration_pi_identity_mismatch/);
});

test("migration discovery is canonical-root only and includes known plus explicit legacy roots", () => {
  const home = "/tmp/test-home";
  const canonical = canonicalDefaultStateRoot(home);
  assert.equal(automaticMigrationEnabled(canonical, {}, home), true);
  assert.equal(automaticMigrationEnabled(canonical, { PI_AGENT_MCP_STATE_DIR: canonical }, home), false);
  assert.equal(automaticMigrationEnabled("/tmp/isolated", {}, home), false);
  assert.deepEqual(discoverLegacySources({ PI_AGENT_MCP_LEGACY_STATE_DIRS: `/tmp/a${process.platform === "win32" ? ";" : ":"}/tmp/b` }, home), [
    join(home, ".pi", "agent-mcp", "sessions.json"),
    join(home, ".pi", "agent-mcp-claude", "sessions.json"),
    join(home, ".pi", "agent-mcp-codex", "sessions.json"),
    "/tmp/a/sessions.json",
    "/tmp/b/sessions.json",
  ]);
  assert.notEqual(migrationIdentifier("/tmp/one", "same"), migrationIdentifier("/tmp/two", "same"));
});

async function onlyTransactionDirectory(root: string): Promise<string> {
  const migrations = join(root, "migrations");
  const entries = (await readdir(migrations)).filter((entry) => entry.startsWith("v1-"));
  assert.equal(entries.length, 1);
  return join(migrations, entries[0]!);
}

async function writeFileEnsuringParent(path: string, content: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

test("V1SessionMigrator resumes legacy UUID quarantine intents while new migrations use retired hashes", async () => {
  const h = await harness();
  await writeManifest(h, true);
  const crashing = migrator(h, {
    root: h.root,
    recordStore: h.store,
    hooks: { beforeSourceTransition: () => { throw new Error("pause before legacy retirement"); } },
  });
  await assert.rejects(crashing.migrateSource(h.sourcePath), /pause before legacy retirement/);
  const transaction = await onlyTransactionDirectory(h.root);
  const intentPath = join(transaction, "intent.json");
  const intent = JSON.parse(await readFile(intentPath, "utf8")) as Record<string, any>;
  intent.quarantinePath = join(dirname(intent.sourcePath), `sessions.v1.quarantine-${intent.migrationId}-legacy-uuid.json`);
  await writeFile(intentPath, `${JSON.stringify(intent, null, 2)}\n`);

  const outcomes = await migrator(h).resumeIncomplete();
  assert.equal(outcomes[0]?.status, "resumed");
  assert.equal(outcomes[0]?.retiredPath, intent.quarantinePath);
  await access(intent.quarantinePath);
});
