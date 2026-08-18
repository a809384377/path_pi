import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/server.js";
import { SessionManager } from "../src/session/session-manager.js";
import { JsonSessionStore } from "../src/store/session-store.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-pi.mjs");

function parseText(result: unknown): unknown {
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
  const content = (result as { content?: unknown[] }).content;
  assert.ok(content);
  const item = content[0] as { type: string; text: string };
  assert.equal(item.type, "text");
  return JSON.parse(item.text);
}

test("MCP exposes five tools and supports spawn, wait, send, status, and close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-mcp-tools-"));
  const manager = new SessionManager({
    store: new JsonSessionStore(join(directory, "sessions.json")),
    executable: fixture,
    commandTimeoutMs: 1_000,
    shutdownGraceMs: 100,
  });
  await manager.initialize();

  const server = new McpServer({ name: "test-server", version: "0.1.0" });
  registerTools(server, manager);
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["pi_close", "pi_send", "pi_spawn", "pi_status", "pi_wait"],
  );

  const spawned = parseText(
    await client.callTool({ name: "pi_spawn", arguments: { task: "mcp-first", cwd: directory, name: "mcp-worker" } }),
  ) as { session_id: string; task_id: string };
  const first = parseText(
    await client.callTool({ name: "pi_wait", arguments: { task_ids: [spawned.task_id], mode: "all", timeout_seconds: 1 } }),
  ) as { completed: Array<{ response: string }> };
  assert.match(first.completed[0]!.response, /mcp-first/);

  const sent = parseText(
    await client.callTool({ name: "pi_send", arguments: { session_id: spawned.session_id, task: "mcp-second" } }),
  ) as { task_id: string };
  const second = parseText(
    await client.callTool({ name: "pi_wait", arguments: { task_ids: [sent.task_id], mode: "all", timeout_seconds: 1 } }),
  ) as { completed: Array<{ response: string }> };
  assert.match(second.completed[0]!.response, /mcp-first\|mcp-second/);

  const status = parseText(
    await client.callTool({ name: "pi_status", arguments: { session_id: spawned.session_id } }),
  ) as { state: string };
  assert.equal(status.state, "idle");
  const closed = parseText(
    await client.callTool({ name: "pi_close", arguments: { session_id: spawned.session_id } }),
  ) as { state: string };
  assert.equal(closed.state, "closed");

  await client.close();
  await server.close();
  await manager.shutdown();
});
