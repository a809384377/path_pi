import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/**
 * Host-provided home/temp locations and the conventional /tmp and /var/tmp
 * aliases are accepted as already-established trust anchors. The anchor itself
 * may be an OS-managed symlink (notably /tmp -> /private/tmp on macOS), but
 * every lexical component below the selected anchor is checked with lstat and
 * must not be a symlink. Paths outside those anchors are checked from their
 * filesystem root.
 */
export async function assertNoSymlinkComponents(path: string, options: { allowMissing?: boolean } = {}): Promise<void> {
  const absolute = absolutePath(path);
  const anchor = trustedAnchorFor(absolute);
  const anchorInfo = await stat(anchor);
  if (!anchorInfo.isDirectory()) throw new Error(`unsafe_path: trusted anchor is not a directory: ${anchor}`);
  const suffix = relative(anchor, absolute);
  if (suffix === "") return;
  const components = suffix.split(sep).filter(Boolean);
  let cursor = anchor;
  for (let index = 0; index < components.length; index += 1) {
    cursor = join(cursor, components[index]!);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`unsafe_path: symlink component: ${cursor}`);
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`unsafe_path: non-directory path component: ${cursor}`);
    }
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = absolutePath(path);
  await assertNoSymlinkComponents(absolute, { allowMissing: true });
  const missing: string[] = [];
  let cursor = absolute;
  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe_path: directory is not private regular directory: ${cursor}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error(`unsafe_path: no existing parent for ${absolute}`);
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertPrivateDirectory(directory);
    // This also runs after an accepted concurrent EEXIST, so no process may
    // proceed while depending on another creator to make the entry durable.
    await syncDirectory(dirname(directory));
  }
  await assertPrivateDirectory(absolute);
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const absolute = absolutePath(path);
  await assertNoSymlinkComponents(absolute);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe_path: expected directory: ${absolute}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`unsafe_path: directory permissions must be 0700: ${absolute}`);
  if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) {
    throw new Error(`unsafe_path: directory is not owned by current user: ${absolute}`);
  }
}

export interface SecureReadOptions {
  requireMode?: number;
  requireCurrentUid?: boolean;
}

export interface AtomicWriteHooks {
  afterPublish?: () => Promise<void> | void;
}

export class AtomicWriteError extends Error {
  readonly published: boolean;

  constructor(error: unknown, published: boolean) {
    super(errorMessage(error), { cause: error });
    this.name = "AtomicWriteError";
    this.published = published;
    const code = (error as NodeJS.ErrnoException).code;
    if (code) (this as NodeJS.ErrnoException).code = code;
  }
}

export function atomicWriteWasPublished(error: unknown): boolean {
  return error instanceof AtomicWriteError && error.published;
}

export async function readSecureFile(path: string, options: SecureReadOptions = {}): Promise<Buffer> {
  const absolute = absolutePath(path);
  await assertNoSymlinkComponents(absolute);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(`unsafe_file_open: ${absolute}: ${errorMessage(error)}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error(`unsafe_file_type: ${absolute}`);
    if (options.requireMode !== undefined && (Number(opened.mode) & 0o777) !== options.requireMode) {
      throw new Error(`unsafe_file_mode: ${absolute} must be ${options.requireMode.toString(8).padStart(4, "0")}`);
    }
    if (options.requireCurrentUid && typeof process.geteuid === "function" && Number(opened.uid) !== process.geteuid()) {
      throw new Error(`unsafe_file_owner: ${absolute}`);
    }
    const before = await lstat(absolute, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) {
      throw new Error(`unsafe_file_identity: ${absolute}`);
    }
    const bytes = await handle.readFile();
    await assertNoSymlinkComponents(absolute);
    const after = await lstat(absolute, { bigint: true });
    if (after.isSymbolicLink() || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`unsafe_file_identity: ${absolute}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function publishNoReplace(
  path: string,
  bytes: Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const absolute = absolutePath(path);
  const directory = dirname(absolute);
  await assertPrivateDirectory(directory);
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let published = false;
  try {
    await link(temporary, absolute);
    published = true;
    await hooks.afterPublish?.();
    await unlink(temporary);
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new AtomicWriteError(error, published);
  }
}

export async function replaceAtomic(
  path: string,
  bytes: Uint8Array,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const absolute = absolutePath(path);
  const directory = dirname(absolute);
  await assertPrivateDirectory(directory);
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let published = false;
  try {
    await rename(temporary, absolute);
    published = true;
    await hooks.afterPublish?.();
    await syncDirectory(directory);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new AtomicWriteError(error, published);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const absolute = absolutePath(path);
  await assertNoSymlinkComponents(absolute);
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) throw new Error(`unsafe_path: expected directory: ${absolute}`);
    await handle.sync();
    await assertNoSymlinkComponents(absolute);
  } finally {
    await handle.close();
  }
}

function trustedAnchorFor(path: string): string {
  const root = parse(path).root;
  const candidates = [...new Set([resolve(homedir()), resolve(tmpdir()), resolve("/tmp"), resolve("/var/tmp"), root])]
    .filter((candidate) => isWithin(candidate, path))
    .sort((left, right) => right.length - left.length);
  return candidates[0] ?? root;
}

function isWithin(anchor: string, path: string): boolean {
  const suffix = relative(anchor, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

function absolutePath(path: string): string {
  if (!isAbsolute(path)) throw new Error(`unsafe_path: path must be absolute: ${path}`);
  return resolve(path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
