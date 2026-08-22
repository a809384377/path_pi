import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { assertNoSymlinkComponents } from "./secure-fs.js";

export const MAX_PI_SESSION_HEADER_BYTES = 64 * 1024;
export const SUPPORTED_PI_SESSION_VERSIONS = new Set([1, 2, 3]);

export interface PiSessionIdentity {
  sessionId: string;
  version: number;
  cwd: string;
  path: string;
  device: bigint;
  inode: bigint;
}

export async function readPiSessionIdentity(path: string): Promise<PiSessionIdentity> {
  if (!isAbsolute(path)) throw new Error("pi_session_invalid_path: path must be absolute");
  const absolute = resolve(path);
  try {
    await assertNoSymlinkComponents(absolute);
  } catch (error) {
    if (String(error).includes("unsafe_path:")) throw error;
    throw new Error(`pi_session_open_failed: ${path}: ${errorMessage(error)}`);
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw new Error(`pi_session_open_failed: ${path}: ${errorMessage(error)}`);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw new Error(`pi_session_not_regular: ${path}`);
    const before = await lstat(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`pi_session_not_regular: ${path}`);
    assertSameIdentity(path, opened.dev, opened.ino, before.dev, before.ino);

    const buffer = Buffer.alloc(MAX_PI_SESSION_HEADER_BYTES + 1);
    let length = 0;
    let newline = -1;
    while (length < buffer.length && newline === -1) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      const found = buffer.indexOf(0x0a, length);
      length += bytesRead;
      if (found !== -1 && found < length) newline = found;
    }
    if (newline === -1) {
      if (length > MAX_PI_SESSION_HEADER_BYTES) throw new Error(`pi_session_header_too_long: ${path}`);
      throw new Error(`pi_session_header_missing_newline: ${path}`);
    }
    if (newline + 1 > MAX_PI_SESSION_HEADER_BYTES) throw new Error(`pi_session_header_too_long: ${path}`);
    let headerBytes = buffer.subarray(0, newline);
    if (headerBytes.at(-1) === 0x0d) headerBytes = headerBytes.subarray(0, headerBytes.length - 1);
    if (headerBytes.length === 0 || headerBytes.toString("utf8").trim().length === 0) {
      throw new Error(`pi_session_header_blank: ${path}`);
    }
    const text = decodeUtf8(headerBytes, path);
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`pi_session_header_malformed: ${path}: ${errorMessage(error)}`);
    }
    const header = validateHeader(value, path);

    await assertNoSymlinkComponents(absolute);
    const after = await lstat(absolute, { bigint: true });
    assertSameIdentity(path, opened.dev, opened.ino, after.dev, after.ino);
    return { ...header, path, device: opened.dev, inode: opened.ino };
  } finally {
    await handle.close();
  }
}

function validateHeader(value: unknown, path: string): Pick<PiSessionIdentity, "sessionId" | "version" | "cwd"> {
  if (!isRecord(value) || value.type !== "session") throw new Error(`pi_session_header_invalid_type: ${path}`);
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || !SUPPORTED_PI_SESSION_VERSIONS.has(value.version)) {
    throw new Error(`pi_session_header_unsupported_version: ${path}`);
  }
  if (typeof value.id !== "string" || !isValidPiSessionId(value.id)) {
    throw new Error(`pi_session_header_invalid_id: ${path}`);
  }
  if (typeof value.cwd !== "string" || !isAbsolute(value.cwd)) {
    throw new Error(`pi_session_header_invalid_cwd: ${path}`);
  }
  return { sessionId: value.id, version: value.version, cwd: value.cwd };
}

function decodeUtf8(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`pi_session_header_invalid_utf8: ${path}: ${errorMessage(error)}`);
  }
}

function assertSameIdentity(path: string, openDevice: bigint, openInode: bigint, pathDevice: bigint, pathInode: bigint): void {
  if (openDevice !== pathDevice || openInode !== pathInode) throw new Error(`pi_session_path_changed: ${path}`);
}

function isValidPiSessionId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
