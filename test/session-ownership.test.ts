import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ownershipSupportedMatrix } from "../src/ownership/flock.js";
import {
  FlockMigrationCandidateLockCoordinator,
  OwnershipLockManager,
  deduplicateAndOrderCandidates,
} from "../src/ownership/session-ownership.js";

const fixture = join(process.cwd(), "test", "fixtures", "ownership-child.mjs");
const modulePath = join(process.cwd(), "dist", "src", "ownership", "session-ownership.js");

function child(root: string, command: string, domain = "logical", key = "shared"): ChildProcess {
  return spawn(process.execPath, [fixture, modulePath, command, root, domain, key], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function lines(process: ChildProcess): { values: string[]; waitFor: (prefix: string) => Promise<string> } {
  const values: string[] = [];
  const waiters: Array<{ prefix: string; resolve: (line: string) => void }> = [];
  let buffer = "";
  process.stdout!.on("data", (chunk) => {
    buffer += chunk.toString();
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      values.push(line);
      for (const waiter of [...waiters]) if (line.startsWith(waiter.prefix)) waiter.resolve(line);
      index = buffer.indexOf("\n");
    }
  });
  return {
    values,
    waitFor: (prefix) => {
      const existing = values.find((line) => line.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ prefix, resolve }));
    },
  };
}

function exited(process: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => process.once("exit", resolve));
}

async function acquireInChild(root: string, domain = "logical", key = "shared"): Promise<{ output: string; code: number | null }> {
  const process = child(root, "once", domain, key);
  let output = "";
  process.stdout!.on("data", (chunk) => output += chunk.toString());
  const code = await exited(process);
  return { output, code };
}

test("package metadata and ownership diagnostics declare the frozen support matrix", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    engines: { node: string };
    os: string[];
    cpu: string[];
    dependencies: Record<string, string>;
  };
  assert.equal(manifest.engines.node, ">=22.19 <26");
  assert.deepEqual(manifest.os, ["darwin", "linux"]);
  assert.deepEqual(manifest.cpu, ["x64", "arm64"]);
  assert.equal(manifest.dependencies["fs-ext-extra-prebuilt"], "2.2.12");
  assert.equal(ownershipSupportedMatrix, "macOS/Linux x64/arm64 with Node >=22.19 <26");
});

test("kernel ownership allows exactly one of 50 simultaneous logical contenders", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ownership-50-"));
  const processes = Array.from({ length: 50 }, () => child(root, "contend"));
  const outputs = processes.map(lines);
  await Promise.all(outputs.map((output) => output.waitFor("ready")));
  for (const process of processes) process.stdin!.write("go\n");
  const codes = await Promise.all(processes.map(exited));
  assert.equal(codes.filter((code) => code === 0).length, 1);
  assert.equal(outputs.flatMap((output) => output.values).filter((line) => line === "acquired").length, 1);
  assert.equal(outputs.flatMap((output) => output.values).filter((line) => line.includes("session_in_use")).length, 49);
});

test("different ownership keys are independent and lock inode remains stable across release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ownership-independent-"));
  const manager = new OwnershipLockManager(root);
  const [first, second] = await Promise.all([
    manager.acquire("logical", "alpha"),
    manager.acquire("logical", "beta"),
  ]);
  const path = first.path;
  const inode = (await stat(path)).ino;
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await Promise.all([first.close(), second.close()]);
  const reacquired = await manager.acquire("logical", "alpha");
  assert.equal((await stat(path)).ino, inode);
  assert.match(await readFile(path, "utf8"), /"domain":"logical"/);
  await reacquired.close();
});

test("ownership rejects unsafe lock files without replacing or unlinking them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ownership-unsafe-"));
  const manager = new OwnershipLockManager(root);
  await manager.initialize();
  const badMode = manager.lockPath("logical", "bad-mode");
  await writeFile(badMode, "existing\n", { mode: 0o600 });
  await chmod(badMode, 0o644);
  await assert.rejects(manager.acquire("logical", "bad-mode"), /ownership_unavailable.*0600/);
  assert.equal((await stat(badMode)).mode & 0o777, 0o644);

  const external = join(root, "external-file");
  await writeFile(external, "external\n", { mode: 0o600 });
  const linked = manager.lockPath("native", "linked");
  await symlink(external, linked);
  await assert.rejects(manager.acquire("native", "linked"), /unsafe_path|ownership_unavailable/);
  assert.equal(await readFile(external, "utf8"), "external\n");
});

test("inherited descriptor fences after parent SIGKILL until child exits", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ownership-inherit-"));
  const parent = child(root, "inherit");
  const output = lines(parent);
  const line = await output.waitFor("inherited:");
  const inheritedPid = Number(line.slice("inherited:".length));
  assert.ok(Number.isSafeInteger(inheritedPid));
  try {
    parent.kill("SIGKILL");
    await exited(parent);
    const blocked = await acquireInChild(root);
    assert.equal(blocked.code, 2);
    assert.match(blocked.output, /session_in_use/);
    process.kill(inheritedPid, "SIGKILL");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await acquireInChild(root);
      if (result.code === 0) {
        assert.match(result.output, /acquired/);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("ownership remained blocked after inherited child exit");
  } finally {
    try { parent.kill("SIGKILL"); } catch {}
    try { process.kill(inheritedPid, "SIGKILL"); } catch {}
  }
});

test("migration coordinator orders, deduplicates and contends through kernel locks", async () => {
  assert.deepEqual(
    deduplicateAndOrderCandidates([
      { kind: "native", key: "n" },
      { kind: "logical", key: "b" },
      { kind: "migration", key: "v1" },
      { kind: "source", key: "/source" },
      { kind: "logical", key: "a" },
      { kind: "native", key: "n" },
    ]).map((candidate) => `${candidate.kind}:${candidate.key}`),
    ["migration:v1", "source:/source", "logical:a", "logical:b", "native:n"],
  );

  const root = await mkdtemp(join(tmpdir(), "pi-ownership-migration-"));
  const manager = new OwnershipLockManager(root);
  const coordinator = new FlockMigrationCandidateLockCoordinator(manager);
  let release!: () => void;
  let markEntered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const first = coordinator.withCandidateLocks([{ kind: "migration", key: "v1" }], async () => {
    markEntered();
    await gate;
  });
  await entered;
  await assert.rejects(
    coordinator.withCandidateLocks([{ kind: "migration", key: "v1" }], async () => undefined),
    /migration_blocked/,
  );
  release();
  await first;
  await coordinator.withCandidateLocks([{ kind: "migration", key: "v1" }], async () => undefined);
});

test("ownership initialize and acquire normalize secure path failures without paths", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-ownership-path-normalize-"));
  const external = await mkdtemp(join(tmpdir(), "pi-ownership-path-external-"));
  const linkedRoot = join(parent, "linked-root");
  await symlink(external, linkedRoot);
  const manager = new OwnershipLockManager(linkedRoot);
  for (const operation of [() => manager.initialize(), () => manager.acquire("logical", "safe-key")]) {
    await assert.rejects(operation, (error: unknown) => {
      assert.equal((error as Error).message, "ownership_unavailable: secure ownership path validation failed");
      assert.doesNotMatch((error as Error).message, new RegExp(parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  }
});
