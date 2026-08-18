import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePrivateDirectory } from "../src/store/secure-fs.js";
import {
  SessionRecordStore,
  sessionRecordHash,
  type SessionRecordV2,
} from "../src/store/session-store.js";

function record(sessionId: string, overrides: Partial<SessionRecordV2> = {}): SessionRecordV2 {
  return {
    version: 2,
    sessionId,
    revision: 1,
    generation: 1,
    cwd: "/tmp",
    state: "creating",
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
  await writeFile(join(store.sessionsDirectory, `${sessionRecordHash(corruptId)}.json`), "{broken");
  await assert.rejects(store.list(), /Invalid session record/);
});

test("SessionRecordStore rejects records whose final filename does not match the logical ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-store-"));
  const store = new SessionRecordStore(root);
  await mkdir(store.sessionsDirectory, { recursive: true, mode: 0o700 });
  const wrongPath = join(store.sessionsDirectory, `${sessionRecordHash("wrong")}.json`);
  await writeFile(wrongPath, `${JSON.stringify(record("actual"))}\n`);
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
  await writeFile(externalRecord, `${JSON.stringify(record("beta"))}\n`);
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

test("SessionRecordStore rejects non-private existing directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-record-mode-"));
  await chmod(root, 0o755);
  await assert.rejects(new SessionRecordStore(root).create(record("alpha")), /permissions must be 0700/);
});
