import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "../../npm/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../../npm/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { McpServer } from "../../npm/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js";
import { registerTools } from "../../npm/src/server.js";
import { OwnershipLockManager } from "../../npm/src/ownership/session-ownership.js";
import { SessionManager } from "../../npm/src/session/session-manager.js";
import { SessionRecordStore } from "../../npm/src/store/session-store.js";

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
    store: new SessionRecordStore(directory),
    executable: fixture,
    commandTimeoutMs: 1_000,
    shutdownGraceMs: 100,
  });
  await manager.initialize();

  const server = new McpServer({ name: "test-server", version: "0.1.0" });
  registerTools(server, manager, { waitHeartbeatMs: 10 });
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name, inputSchema }) => ({ name, inputSchema })).sort((left, right) => left.name.localeCompare(right.name)),
    [
      {
        name: "pi_close",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string", minLength: 1 } },
          required: ["session_id"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
      {
        name: "pi_send",
        inputSchema: {
          type: "object",
          properties: {
            session_id: { type: "string", minLength: 1 },
            task: { type: "string", minLength: 1 },
          },
          required: ["session_id", "task"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
      {
        name: "pi_spawn",
        inputSchema: {
          type: "object",
          properties: {
            task: { type: "string", minLength: 1, description: "Task for the new Pi session" },
            cwd: { type: "string", minLength: 1, description: "Absolute working directory for Pi" },
            name: { type: "string", minLength: 1, description: "Human-readable session name" },
            model: { type: "string", minLength: 1, description: "Optional Pi provider/model selector" },
          },
          required: ["task", "cwd"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
      {
        name: "pi_status",
        inputSchema: {
          type: "object",
          properties: { session_id: { type: "string", minLength: 1 } },
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
      {
        name: "pi_wait",
        inputSchema: {
          type: "object",
          properties: {
            task_ids: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
            mode: { type: "string", enum: ["any", "all"], default: "any" },
          },
          required: ["task_ids"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      },
    ],
  );

  const spawned = parseText(
    await client.callTool({ name: "pi_spawn", arguments: { task: "mcp-first delay:150", cwd: directory, name: "mcp-worker" } }),
  ) as { session_id: string; task_id: string };
  const cancelledProgress: number[] = [];
  const cancellation = new AbortController();
  const cancelledWait = client.callTool(
    { name: "pi_wait", arguments: { task_ids: [spawned.task_id], mode: "all" } },
    undefined,
    {
      signal: cancellation.signal,
      onprogress: (update) => cancelledProgress.push(update.progress),
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(cancelledProgress.length >= 1);
  assert.equal(manager.listenerCount("taskTerminal"), 1);
  cancellation.abort(new Error("cancel test wait"));
  await assert.rejects(cancelledWait, /cancel test wait/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(manager.listenerCount("taskTerminal"), 0);
  assert.equal(manager.listenerCount("taskPersistenceError"), 0);
  const cancelledProgressCount = cancelledProgress.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cancelledProgress.length, cancelledProgressCount);

  const alreadyCancelled = new AbortController();
  alreadyCancelled.abort(new Error("already cancelled wait"));
  await assert.rejects(
    manager.wait([spawned.task_id], "all", alreadyCancelled.signal),
    /already cancelled wait/,
  );
  assert.equal(manager.listenerCount("taskTerminal"), 0);
  assert.equal(manager.listenerCount("taskPersistenceError"), 0);

  const progress: number[] = [];
  const first = parseText(
    await client.callTool(
      { name: "pi_wait", arguments: { task_ids: [spawned.task_id], mode: "all" } },
      undefined,
      { onprogress: (update) => progress.push(update.progress) },
    ),
  ) as { completed: Array<{ response: string }> };
  assert.match(first.completed[0]!.response, /mcp-first/);
  assert.ok(progress.length >= 2);
  assert.deepEqual(progress, progress.map((_, index) => index + 1));
  const terminalProgressCount = progress.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(progress.length, terminalProgressCount);

  const sent = parseText(
    await client.callTool({ name: "pi_send", arguments: { session_id: spawned.session_id, task: "mcp-second" } }),
  ) as { task_id: string };
  const second = parseText(
    await client.callTool({ name: "pi_wait", arguments: { task_ids: [sent.task_id], mode: "all" } }),
  ) as { completed: Array<{ response: string }> };
  assert.match(second.completed[0]!.response, /mcp-first.*\|mcp-second/);

  const status = parseText(
    await client.callTool({ name: "pi_status", arguments: { session_id: spawned.session_id } }),
  ) as { state: string };
  assert.equal(status.state, "idle");

  const contenderManager = new SessionManager({
    store: new SessionRecordStore(directory),
    ownership: new OwnershipLockManager(directory),
    executable: fixture,
    commandTimeoutMs: 1_000,
    shutdownGraceMs: 100,
  });
  await contenderManager.initialize();
  const contenderServer = new McpServer({ name: "contender-server", version: "0.1.0" });
  registerTools(contenderServer, contenderManager);
  const contenderClient = new Client({ name: "contender-client", version: "0.1.0" });
  const [contenderClientTransport, contenderServerTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([contenderServer.connect(contenderServerTransport), contenderClient.connect(contenderClientTransport)]);
  const contention = parseText(await contenderClient.callTool({
    name: "pi_send",
    arguments: { session_id: spawned.session_id, task: "must-not-run" },
  })) as { error: string };
  assert.deepEqual(contention, { error: "session_in_use" });
  await contenderClient.close();
  await contenderServer.close();
  await contenderManager.shutdown();

  const closed = parseText(
    await client.callTool({ name: "pi_close", arguments: { session_id: spawned.session_id } }),
  ) as { state: string };
  assert.equal(closed.state, "closed");

  await client.close();
  await server.close();
  await manager.shutdown();
});
