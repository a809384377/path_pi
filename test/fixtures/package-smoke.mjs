#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [bin, fakePi] = process.argv.slice(2);
if (!bin || !fakePi) throw new Error("Usage: node test/fixtures/package-smoke.mjs <bin> <fake-pi>");

const root = await mkdtemp(join(tmpdir(), "pi-agent-mcp-pack-smoke-"));
const child = spawn(bin, [], {
  env: {
    ...process.env,
    PI_AGENT_MCP_STATE_DIR: join(root, "state"),
    PI_AGENT_MCP_PI_EXECUTABLE: fakePi,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let stderr = "";
const messages = new Map();
child.stderr.on("data", (chunk) => stderr += chunk.toString());
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined) messages.set(message.id, message);
  }
});

function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}

function wait(id) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const timer = setInterval(() => {
      if (messages.has(id)) {
        clearInterval(timer);
        resolve(messages.get(id));
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`timeout waiting for ${id}; stderr=${stderr}`));
      }
    }, 10);
  });
}

try {
  const version = (await readFile(bin, "utf8")).length > 0;
  if (!version) throw new Error("installed bin is empty");
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "pack-smoke", version: "1.0.0" },
    },
  });
  const initialize = await wait(1);
  if (initialize.error) throw new Error(JSON.stringify(initialize.error));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = await wait(2);
  const names = tools.result.tools.map((tool) => tool.name).sort();
  const expected = ["pi_close", "pi_send", "pi_spawn", "pi_status", "pi_wait"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`wrong tools: ${JSON.stringify(names)}`);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "pi_spawn",
    arguments: { task: "package smoke", cwd: root, name: "package-smoke" },
  } });
  const spawnResult = await wait(3);
  if (spawnResult.error) throw new Error(JSON.stringify(spawnResult.error));
  const spawned = JSON.parse(spawnResult.result.content[0].text);
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
    name: "pi_wait",
    arguments: { task_ids: [spawned.task_id], mode: "all" },
  } });
  const waitResult = await wait(4);
  if (waitResult.error) throw new Error(JSON.stringify(waitResult.error));
  const completed = JSON.parse(waitResult.result.content[0].text);
  if (completed.completed[0]?.status !== "completed") throw new Error(`task did not complete: ${JSON.stringify(completed)}`);
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: {
    name: "pi_close",
    arguments: { session_id: spawned.session_id },
  } });
  const closeResult = await wait(5);
  if (closeResult.error) throw new Error(JSON.stringify(closeResult.error));
  const closed = JSON.parse(closeResult.result.content[0].text);
  if (closed.state !== "closed") throw new Error(`session did not close: ${JSON.stringify(closed)}`);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`shutdown timeout; stderr=${stderr}`)), 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`exit ${code}; stderr=${stderr}`));
    });
  });
  process.stdout.write(`MCP pack smoke passed: ${names.join(", ")}; spawn/wait/close passed\n`);
} catch (error) {
  child.kill("SIGKILL");
  throw error;
}
