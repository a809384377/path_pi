import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SessionManager } from "./session/session-manager.js";
import { JsonSessionStore } from "./store/session-store.js";

export interface ServerRuntime {
  server: McpServer;
  manager: SessionManager;
}

export async function createServerRuntime(env: NodeJS.ProcessEnv = process.env): Promise<ServerRuntime> {
  const stateDirectory = env.PI_AGENT_MCP_STATE_DIR ?? join(homedir(), ".pi", "agent-mcp");
  const store = new JsonSessionStore(join(stateDirectory, "sessions.json"));
  const manager = new SessionManager({
    store,
    ...(env.PI_AGENT_MCP_PI_EXECUTABLE ? { executable: env.PI_AGENT_MCP_PI_EXECUTABLE } : {}),
    maxSessions: parsePositiveInteger(env.PI_AGENT_MCP_MAX_SESSIONS, 16),
    commandTimeoutMs: parsePositiveInteger(env.PI_AGENT_MCP_COMMAND_TIMEOUT_MS, 30_000),
    shutdownGraceMs: parsePositiveInteger(env.PI_AGENT_MCP_SHUTDOWN_GRACE_MS, 1_000),
    logger: (message) => process.stderr.write(`[pi] ${message}`),
  });
  await manager.initialize();

  const server = new McpServer({ name: "pi-agent-mcp", version: "0.1.0" });
  registerTools(server, manager);
  return { server, manager };
}

export function registerTools(server: McpServer, manager: SessionManager): void {
  server.registerTool(
    "pi_spawn",
    {
      description:
        "Create a new persistent Pi coding-agent session and start a task in the background. Returns immediately; call pi_wait with the task_id before relying on its result.",
      inputSchema: {
        task: z.string().min(1).describe("Task for the new Pi session"),
        cwd: z.string().min(1).describe("Absolute working directory for Pi"),
        name: z.string().min(1).optional().describe("Human-readable session name"),
        model: z.string().min(1).optional().describe("Optional Pi provider/model selector"),
      },
    },
    async ({ task, cwd, name, model }) =>
      toolResult(() =>
        manager.spawn({
          task,
          cwd,
          ...(name ? { name } : {}),
          ...(model ? { model } : {}),
        }),
      ),
  );

  server.registerTool(
    "pi_send",
    {
      description:
        "Send the next task to an existing idle or dormant Pi session, preserving its prior context. Busy sessions reject the call; use pi_wait for the active task first.",
      inputSchema: {
        session_id: z.string().min(1),
        task: z.string().min(1),
      },
    },
    async ({ session_id, task }) => toolResult(() => manager.send(session_id, task)),
  );

  server.registerTool(
    "pi_wait",
    {
      description:
        "Wait for any or all background Pi tasks by immutable task_id. Results are observational and may be read repeatedly. A timeout does not fail or cancel tasks.",
      inputSchema: {
        task_ids: z.array(z.string().min(1)).min(1),
        mode: z.enum(["any", "all"]).default("any"),
        timeout_seconds: z.number().min(0).max(300).default(60),
      },
    },
    async ({ task_ids, mode, timeout_seconds }) =>
      toolResult(() => manager.wait(task_ids, mode, Math.round(timeout_seconds * 1_000))),
  );

  server.registerTool(
    "pi_status",
    {
      description:
        "Inspect one Pi session, or list all non-closed sessions when session_id is omitted. This never starts a dormant process. finalizing means the terminal outcome is still being durably saved and the session remains busy.",
      inputSchema: {
        session_id: z.string().min(1).optional(),
      },
    },
    async ({ session_id }) =>
      toolResult(() => Promise.resolve(session_id === undefined ? manager.status() : manager.status(session_id))),
  );

  server.registerTool(
    "pi_close",
    {
      description:
        "Permanently close a logical Pi session. Its active task becomes aborted, its process tree is stopped, and the native Pi session file is retained.",
      inputSchema: {
        session_id: z.string().min(1),
      },
    },
    async ({ session_id }) => toolResult(() => manager.close(session_id)),
  );
}

export async function runStdioServer(): Promise<void> {
  const { server, manager } = await createServerRuntime();
  const transport = new StdioServerTransport();
  let shuttingDown: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shuttingDown ??= manager.shutdown().then(() => server.close());
    return shuttingDown;
  };

  const handleSignal = (): void => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`pi-agent-mcp shutdown failed: ${errorMessage(error)}\n`);
        process.exit(1);
      });
  };
  const handleInputEnd = (): void => {
    void shutdown().catch((error: unknown) => {
      process.stderr.write(`pi-agent-mcp shutdown failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  process.stdin.once("end", handleInputEnd);
  process.stdin.once("close", handleInputEnd);
  transport.onclose = handleInputEnd;
  await server.connect(transport);
}

async function toolResult<T>(operation: () => Promise<T>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const value = await operation();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: errorMessage(error) }, null, 2) }],
      isError: true,
    };
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer configuration: ${value}`);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
