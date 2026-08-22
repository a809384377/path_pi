import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonSessionStore, validateManifest, type SessionManifest } from "../../npm/src/store/session-store.js";

const manifest: SessionManifest = {
  version: 1,
  cleanShutdown: false,
  sessions: {
    alpha: {
      sessionId: "alpha",
      generation: 1,
      cwd: "/tmp",
      state: "idle",
      activeTaskId: null,
    },
  },
};

test("JsonSessionStore atomically persists and loads a manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-store-"));
  const path = join(directory, "nested", "sessions.json");
  const store = new JsonSessionStore(path);
  await Promise.all([store.save(manifest), store.save({ ...manifest, cleanShutdown: true })]);

  const loaded = await store.load();
  assert.equal(loaded.cleanShutdown, true);
  assert.equal(loaded.sessions.alpha?.sessionId, "alpha");
  assert.match(await readFile(path, "utf8"), /"version": 1/);
});

test("JsonSessionStore returns an empty clean manifest for a missing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-store-"));
  const store = new JsonSessionStore(join(directory, "sessions.json"));
  assert.deepEqual(await store.load(), { version: 1, cleanShutdown: true, sessions: {} });
});

test("JsonSessionStore rejects malformed manifests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-store-"));
  const path = join(directory, "sessions.json");
  await writeFile(path, '{"version":2,"cleanShutdown":true,"sessions":{}}');
  await assert.rejects(new JsonSessionStore(path).load(), /Invalid pi-agent-mcp session manifest/);
  assert.throws(() => validateManifest({ version: 1, cleanShutdown: true, sessions: { bad: {} } }), /Invalid session bad/);
  assert.throws(
    () =>
      validateManifest({
        version: 1,
        cleanShutdown: true,
        sessions: { bad: { sessionId: "bad", generation: 1, cwd: "/tmp", state: "surprise", activeTaskId: null } },
      }),
    /Invalid session state bad/,
  );
});
