import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_PI_SESSION_HEADER_BYTES,
  readPiSessionIdentity,
} from "../src/store/pi-session-header.js";

async function fixture(content: string | Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-header-"));
  const path = join(directory, "session.jsonl");
  await writeFile(path, content);
  return path;
}

function header(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "session", version: 3, id: "native-1", cwd: "/tmp/project", ...overrides });
}

test("readPiSessionIdentity reads only the first physical line and returns opened identity", async () => {
  const path = await fixture(`${header()}\n{not-json-after-header}\n`);
  const identity = await readPiSessionIdentity(path);
  assert.equal(identity.sessionId, "native-1");
  assert.equal(identity.version, 3);
  assert.equal(identity.cwd, "/tmp/project");
  assert.ok(identity.inode > 0n);
});

test("readPiSessionIdentity rejects blank, malformed, missing-newline, and overlong first lines", async () => {
  for (const [content, pattern] of [
    ["\n", /header_blank/],
    ["{broken\n", /header_malformed/],
    [header(), /header_missing_newline/],
    [`${"x".repeat(MAX_PI_SESSION_HEADER_BYTES)}\n`, /header_too_long/],
  ] as const) {
    await assert.rejects(readPiSessionIdentity(await fixture(content)), pattern);
  }
});

test("readPiSessionIdentity rejects invalid header fields and invalid UTF-8", async () => {
  for (const [content, pattern] of [
    [`${header({ type: "message" })}\n`, /invalid_type/],
    [`${header({ version: 99 })}\n`, /unsupported_version/],
    [`${header({ id: "-bad" })}\n`, /invalid_id/],
    [`${header({ cwd: "relative" })}\n`, /invalid_cwd/],
    [Buffer.from([0xff, 0x0a]), /invalid_utf8/],
  ] as const) {
    await assert.rejects(readPiSessionIdentity(await fixture(content)), pattern);
  }
});

test("readPiSessionIdentity rejects intermediate ancestor symlinks", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-header-parent-"));
  const external = await mkdtemp(join(tmpdir(), "pi-header-external-"));
  const nested = join(external, "sessions");
  await mkdir(nested, { mode: 0o700 });
  await writeFile(join(nested, "session.jsonl"), `${header()}\n`);
  await symlink(external, join(parent, "alias"));

  await assert.rejects(
    readPiSessionIdentity(join(parent, "alias", "sessions", "session.jsonl")),
    /unsafe_path: symlink component/,
  );
});

test("readPiSessionIdentity rejects symlinks and non-regular paths", async () => {
  const target = await fixture(`${header()}\n`);
  const directory = await mkdtemp(join(tmpdir(), "pi-header-link-"));
  const link = join(directory, "session.jsonl");
  await symlink(target, link);
  await assert.rejects(readPiSessionIdentity(link), /unsafe_path|open_failed|ELOOP/);

  const subdirectory = join(directory, "directory");
  await mkdir(subdirectory);
  await assert.rejects(readPiSessionIdentity(subdirectory), /not_regular/);
});
