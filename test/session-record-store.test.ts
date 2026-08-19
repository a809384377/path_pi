import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateDirectory } from "../src/store/secure-fs.js";
import {
  SessionRecordStore,
  sessionRecordHash,
  validateSessionRecord,
  type SessionRecordV2,
} from "../src/store/session-store.js";

function record(sessionId: string, overrides: Partial<SessionRecordV2> = {}): SessionRecordV2 {
  return {
    version: 2,
    sessionId,
    revision: 1,
    generation: 1,
    cwd: "/tmp",
    state: "error",
    recoverable: false,
    activeTaskId: null,
    updatedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  };
}

test("SessionRecordStore allows concurrent writes to different sessions across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-store-"));
  const first = new SessionRecordStore(root);
  const second = new SessionRecordStore(root);
  await Promise.all([first.create(record("alpha")), second.create(record("beta"))]);

  assert.deepEqual((await first.list()).map((item) => item.sessionId).sort(), ["alpha", "beta"]);
  assert.match(first.recordPath("alpha"), new RegExp(`${sessionRecordHash("alpha")}\\.json$`));
});

test("SessionRecordStore create is atomic no-replace across instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-store-"));
  const first = new SessionRecordStore(root);
  const second = new SessionRecordStore(root);
  const outcomes = await Promise.allSettled([
    first.create(record("same", { name: "first" })),
    second.create(record("same", { name: "second" })),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.match(String(outcomes.find((outcome) => outcome.status === "rejected")?.reason), /session_exists/);
  assert.ok(["first", "second"].includes((await first.read("same")).name ?? ""));
});

test("SessionRecordStore exact-existing create still conflicts without local publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-exact-existing-"));
  const first = new SessionRecordStore(root);
  const second = new SessionRecordStore(root);
  const intended = record("alpha");
  await first.create(intended);
  await assert.rejects(second.create(intended), /session_exists/);
  assert.deepEqual(await first.read("alpha"), intended);
});

test("SessionRecordStore reconciles exact post-link and post-rename ambiguous success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-ambiguous-"));
  let createFailures = 1;
  let updateFailures = 1;
  const store = new SessionRecordStore(root, {
    createHooks: { afterPublish: () => { if (createFailures-- > 0) throw new Error("post-link fsync failure"); } },
    updateHooks: { afterPublish: () => { if (updateFailures-- > 0) throw new Error("post-rename fsync failure"); } },
  });
  await store.create(record("alpha"));
  const initial = await store.read("alpha");
  assert.equal(initial.revision, 1);
  await store.updateOwned("alpha", 1, { ...initial, revision: 2, name: "updated" });
  assert.deepEqual(await store.read("alpha"), { ...initial, revision: 2, name: "updated" });
});

test("SessionRecordStore never accepts divergent finals after ambiguous publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-ambiguous-conflict-"));
  let store!: SessionRecordStore;
  store = new SessionRecordStore(root, {
    createHooks: {
      afterPublish: async () => {
        await writeFile(store.recordPath("alpha"), `${JSON.stringify(record("alpha", { name: "different" }), null, 2)}\n`, { mode: 0o600 });
        throw new Error("post-link failure with competing content");
      },
    },
  });
  await assert.rejects(store.create(record("alpha", { name: "intended" })), /post-link failure/);
  assert.equal((await store.read("alpha")).name, "different");

  const updateStore = new SessionRecordStore(root, {
    updateHooks: {
      afterPublish: async () => {
        const current = await store.read("alpha");
        await writeFile(store.recordPath("alpha"), `${JSON.stringify({ ...current, name: "competing" }, null, 2)}\n`, { mode: 0o600 });
        throw new Error("post-rename failure with competing content");
      },
    },
  });
  const base = await updateStore.read("alpha");
  await assert.rejects(
    updateStore.updateOwned("alpha", base.revision, { ...base, revision: base.revision + 1, name: "intended-update" }),
    /post-rename failure/,
  );
  assert.equal((await store.read("alpha")).name, "competing");
});

test("SessionRecordStore serializes same-session updates and rejects stale revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-store-"));
  const store = new SessionRecordStore(root);
  await store.create(record("alpha"));
  const base = await store.read("alpha");
  const outcomes = await Promise.allSettled([
    store.updateOwned("alpha", 1, { ...base, revision: 2, name: "one" }),
    store.updateOwned("alpha", 1, { ...base, revision: 2, name: "two" }),
  ]);
  await store.drain("alpha");

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.match(String(outcomes.find((outcome) => outcome.status === "rejected")?.reason), /revision_conflict/);
  assert.equal((await store.read("alpha")).revision, 2);
});

test("SessionRecordStore preserves immutable migration provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-store-"));
  const store = new SessionRecordStore(root);
  const initial = record("alpha", {
    migration: {
      migrationId: "a".repeat(64),
      sourcePath: "/tmp/sessions.json",
      sourceHash: "b".repeat(64),
      sourceSessionHash: "c".repeat(64),
    },
  });
  await store.create(initial);
  await assert.rejects(
    store.updateOwned("alpha", 1, {
      ...initial,
      revision: 2,
      migration: { ...initial.migration!, sourceHash: "d".repeat(64) },
    }),
    /migration_provenance_immutable/,
  );
});

test("SessionRecordStore list ignores temp files and rejects corrupt final records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-store-"));
  const store = new SessionRecordStore(root);
  await store.create(record("valid"));
  await writeFile(join(store.sessionsDirectory, "ignored.tmp"), "not-json");
  assert.deepEqual((await store.list()).map((item) => item.sessionId), ["valid"]);

  const corruptId = "corrupt";
  await writeFile(join(store.sessionsDirectory, `${sessionRecordHash(corruptId)}.json`), "{broken", { mode: 0o600 });
  await assert.rejects(store.list(), /Invalid session record/);
});

test("SessionRecordStore rejects records whose final filename does not match the logical ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-store-"));
  const store = new SessionRecordStore(root);
  await mkdir(store.sessionsDirectory, { recursive: true, mode: 0o700 });
  const wrongPath = join(store.sessionsDirectory, `${sessionRecordHash("wrong")}.json`);
  await writeFile(wrongPath, `${JSON.stringify(record("actual"))}\n`, { mode: 0o600 });
  await assert.rejects(store.list(), /filename hash mismatch/);
  assert.match(await readFile(wrongPath, "utf8"), /actual/);
});

test("SessionRecordStore rejects symlinked root, sessions directory, and final records", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-record-links-"));
  const external = await mkdtemp(join(tmpdir(), "pi-record-external-"));
  const linkedRoot = join(parent, "linked-root");
  await symlink(external, linkedRoot);
  await assert.rejects(new SessionRecordStore(linkedRoot).create(record("root-link")), /unsafe_path/);

  const root = join(parent, "state");
  await mkdir(root, { mode: 0o700 });
  await symlink(external, join(root, "sessions"));
  await assert.rejects(new SessionRecordStore(root).create(record("sessions-link")), /unsafe_path/);

  const safeRoot = join(parent, "safe-state");
  const store = new SessionRecordStore(safeRoot);
  await store.create(record("alpha"));
  const externalRecord = join(external, "record.json");
  await writeFile(externalRecord, `${JSON.stringify(record("beta"))}\n`, { mode: 0o600 });
  await symlink(externalRecord, store.recordPath("beta"));
  await assert.rejects(store.read("beta"), /unsafe_path|unsafe_file_open|unsafe_file_identity/);
  await assert.rejects(store.list(), /unsafe_path|unsafe_file_open|unsafe_file_identity/);

  for (const directory of [safeRoot, store.sessionsDirectory, store.temporaryDirectory]) {
    assert.equal((await stat(directory)).mode & 0o077, 0);
  }
});

test("SessionRecordStore rejects an intermediate ancestor symlink even when the final root is regular", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-record-parent-"));
  const external = await mkdtemp(join(tmpdir(), "pi-record-external-"));
  await mkdir(join(external, "state"), { mode: 0o700 });
  await symlink(external, join(parent, "alias"));
  const store = new SessionRecordStore(join(parent, "alias", "state"));

  await assert.rejects(store.create(record("alpha")), /unsafe_path: symlink component/);
  await assert.rejects(access(join(external, "state", "sessions")));
});

test("secure directory creation trusts the host /tmp anchor but checks every component below it", async () => {
  const base = await mkdtemp("/tmp/pi-secure-anchor-");
  const directory = join(base, "concurrent", "state");
  await Promise.all(Array.from({ length: 8 }, () => ensurePrivateDirectory(directory)));
  assert.equal((await stat(directory)).mode & 0o077, 0);

  const external = await mkdtemp("/tmp/pi-secure-anchor-external-");
  await mkdir(join(external, "final"), { mode: 0o700 });
  await symlink(external, join(base, "ancestor-link"));
  await assert.rejects(
    ensurePrivateDirectory(join(base, "ancestor-link", "final")),
    /unsafe_path: symlink component/,
  );
});

test("SessionRecordStore rejects non-0600 final records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-file-mode-"));
  const store = new SessionRecordStore(root);
  await store.create(record("alpha"));
  await chmod(store.recordPath("alpha"), 0o644);
  await assert.rejects(store.read("alpha"), /unsafe_file_mode/);
  await assert.rejects(store.list(), /unsafe_file_mode/);
});

test("validateSessionRecord rejects impossible lifecycle combinations", () => {
  const invalid = [
    record("closed-recoverable", { state: "closed", recoverable: true, piSessionId: "native", sessionFile: "/tmp/pi.jsonl" }),
    record("closed-active", { state: "closed", activeTaskId: "task" }),
    record("idle-active", { state: "idle", recoverable: true, piSessionId: "native", sessionFile: "/tmp/pi.jsonl", activeTaskId: "task" }),
    record("creating-no-native", { state: "creating", activeTaskId: "task" }),
    record("creating-no-task", { state: "creating", piSessionId: "native", activeTaskId: null }),
    record("dormant-not-recoverable", { state: "dormant" }),
  ];
  for (const candidate of invalid) assert.throws(() => validateSessionRecord(candidate));
});

test("SessionRecordStore rejects non-private existing directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-mode-"));
  await chmod(root, 0o755);
  await assert.rejects(new SessionRecordStore(root).create(record("alpha")), /permissions must be 0700/);
});

test("SessionRecordStore retries exact create after both publication and reconciliation fsync fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-create-double-fsync-"));
  let publishFailures = 1;
  let reconciliationFailures = 1;
  const store = new SessionRecordStore(root, {
    createHooks: { afterPublish: () => { if (publishFailures-- > 0) throw new Error("create publish fsync failed"); } },
    reconciliationSyncHook: () => { if (reconciliationFailures-- > 0) throw new Error("create reconciliation fsync failed"); },
  });
  const intended = record("double-create");
  await assert.rejects(store.create(intended), /record_durability_uncertain/);
  assert.deepEqual(await store.read(intended.sessionId), intended);
  await store.create(intended);
  assert.deepEqual(await store.read(intended.sessionId), intended);
});

test("SessionRecordStore adopts exact uncertain update before the next successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-update-double-fsync-"));
  let publishFailures = 1;
  let reconciliationFailures = 1;
  const store = new SessionRecordStore(root, {
    updateHooks: { afterPublish: () => { if (publishFailures-- > 0) throw new Error("update publish fsync failed"); } },
    reconciliationSyncHook: () => { if (reconciliationFailures-- > 0) throw new Error("update reconciliation fsync failed"); },
  });
  await store.create(record("double-update"));
  const first = await store.read("double-update");
  const uncertain = { ...first, revision: 2, name: "uncertain" };
  await assert.rejects(store.updateOwned(first.sessionId, 1, uncertain), /record_durability_uncertain/);
  assert.deepEqual(await store.read(first.sessionId), uncertain);
  const successor = { ...uncertain, revision: 3, name: "successor" };
  await store.updateOwned(first.sessionId, 2, successor);
  assert.deepEqual(await store.read(first.sessionId), successor);
});

test("SessionRecordStore rejects a divergent final while retrying uncertain durability", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-uncertain-divergent-"));
  let publishFailures = 1;
  let reconciliationFailures = 1;
  const store = new SessionRecordStore(root, {
    updateHooks: { afterPublish: () => { if (publishFailures-- > 0) throw new Error("update publish fsync failed"); } },
    reconciliationSyncHook: () => { if (reconciliationFailures-- > 0) throw new Error("update reconciliation fsync failed"); },
  });
  await store.create(record("divergent"));
  const first = await store.read("divergent");
  const uncertain = { ...first, revision: 2, name: "uncertain" };
  await assert.rejects(store.updateOwned(first.sessionId, 1, uncertain), /record_durability_uncertain/);
  await writeFile(store.recordPath(first.sessionId), `${JSON.stringify({ ...uncertain, name: "competing" }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    store.updateOwned(first.sessionId, 2, { ...uncertain, revision: 3, name: "successor" }),
    /revision_conflict.*uncertain final changed/,
  );
});

test("validateSessionRecord rejects running without an active task", () => {
  assert.throws(() => validateSessionRecord(record("running-no-task", {
    state: "running",
    recoverable: true,
    piSessionId: "native",
    sessionFile: "/tmp/pi.jsonl",
    activeTaskId: null,
  })));
});
