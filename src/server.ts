import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FlockMigrationCandidateLockCoordinator, OwnershipLockManager } from "./ownership/session-ownership.js";
import { SessionManager } from "./session/session-manager.js";
import { ensurePrivateDirectory } from "./store/secure-fs.js";
import { SessionRecordStore } from "./store/session-store.js";
import {
  V1SessionMigrator,
  automaticMigrationEnabled,
  canonicalDefaultStateRoot,
  discoverLegacySources,
  type MigrationOutcome,
} from "./store/v1-migration.js";

export interface ServerRuntime {
  server: McpServer;
  manager: SessionManager;
  stateRoot: string;
  migrationOutcomes: MigrationOutcome[];
}

export interface ServerConfiguration {
  stateRoot: string;
  canonical: boolean;
  executable?: string;
  maxSessions: number;
  commandTimeoutMs: number;
  shutdownGraceMs: number;
  importDirty: boolean;
}

export function resolveServerConfiguration(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): ServerConfiguration {
  const explicitRoot = env.PI_AGENT_MCP_STATE_DIR;
  const stateRoot = resolve(explicitRoot ?? canonicalDefaultStateRoot(home));
  if (explicitRoot !== undefined && knownLegacyRoots(home).includes(stateRoot)) {
    throw new Error(
      "legacy_state_uncertain: caller-specific legacy state root configured; stop all old clients, remove PI_AGENT_MCP_STATE_DIR, then start one canonical v2 client",
    );
  }
  return {
    stateRoot,
    canonical: automaticMigrationEnabled(stateRoot, env, home),
    ...(env.PI_AGENT_MCP_PI_EXECUTABLE ? { executable: env.PI_AGENT_MCP_PI_EXECUTABLE } : {}),
    maxSessions: parsePositiveInteger(env.PI_AGENT_MCP_MAX_SESSIONS, 16),
    commandTimeoutMs: parsePositiveInteger(env.PI_AGENT_MCP_COMMAND_TIMEOUT_MS, 30_000),
    shutdownGraceMs: parsePositiveInteger(env.PI_AGENT_MCP_SHUTDOWN_GRACE_MS, 1_000),
    importDirty: env.PI_AGENT_MCP_IMPORT_DIRTY === "1",
  };
}

export async function createServerRuntime(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<ServerRuntime> {
  const configuration = resolveServerConfiguration(env, home);
  await ensureRegistryDirectories(configuration.stateRoot);
  const store = new SessionRecordStore(configuration.stateRoot);
  const ownership = new OwnershipLockManager(configuration.stateRoot);
  await ownership.initialize();
  const migrator = new V1SessionMigrator({
    root: configuration.stateRoot,
    recordStore: store,
    coordinator: new FlockMigrationCandidateLockCoordinator(ownership),
    allowDirty: configuration.importDirty,
  });
  const migrationOutcomes = configuration.canonical
    ? await runCanonicalMigrations(migrator, discoverLegacySources(env, home))
    : [];
  const manager = new SessionManager({
    store,
    ownership,
    ...(configuration.executable ? { executable: configuration.executable } : {}),
    maxSessions: configuration.maxSessions,
    commandTimeoutMs: configuration.commandTimeoutMs,
    shutdownGraceMs: configuration.shutdownGraceMs,
    logger: (message) => process.stderr.write(`[pi] ${message}`),
  });
  await manager.initialize();

  const server = new McpServer({ name: "pi-agent-mcp", version: "0.1.0" });
  registerTools(server, manager);
  return { server, manager, stateRoot: configuration.stateRoot, migrationOutcomes };
}

export interface ToolRegistrationOptions {
  waitHeartbeatMs?: number;
}

const defaultWaitHeartbeatMs = 30_000;

export function registerTools(
  server: McpServer,
  manager: SessionManager,
  options: ToolRegistrationOptions = {},
): void {
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
        "Wait for any or all background Pi tasks by immutable task_id. This request remains open until the requested terminal condition is met; it never times out or cancels tasks. For mode=any, completed contains the terminal tasks observed when the first task finishes and pending contains the rest.",
      inputSchema: {
        task_ids: z.array(z.string().min(1)).min(1),
        mode: z.enum(["any", "all"]).default("any"),
      },
    },
    async ({ task_ids, mode }, extra) =>
      toolResult(() => waitWithProgress(
        () => manager.wait(task_ids, mode, extra.signal),
        extra,
        options.waitHeartbeatMs ?? defaultWaitHeartbeatMs,
      )),
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
      toolResult(async () => session_id === undefined ? await manager.status() : await manager.status(session_id)),
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

async function waitWithProgress<T>(
  operation: () => Promise<T>,
  extra: {
    signal: AbortSignal;
    _meta?: { progressToken?: string | number | undefined };
    sendNotification: (notification: {
      method: "notifications/progress";
      params: { progressToken: string | number; progress: number; message: string };
    }) => Promise<void>;
  },
  heartbeatMs: number,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined || heartbeatMs <= 0) return operation();

  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    void extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        message: "Waiting for Pi task terminal state",
      },
    }).catch(() => undefined);
  }, heartbeatMs);
  timer.unref();

  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
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
      content: [{ type: "text", text: JSON.stringify({ error: publicErrorMessage(error) }, null, 2) }],
      isError: true,
    };
  }
}

async function ensureRegistryDirectories(root: string): Promise<void> {
  await ensurePrivateDirectory(root);
  for (const directory of ["sessions", "pi-sessions", "locks", "migrations", "tmp"]) {
    await ensurePrivateDirectory(join(root, directory));
  }
}

async function runCanonicalMigrations(
  migrator: V1SessionMigrator,
  sources: readonly string[],
): Promise<MigrationOutcome[]> {
  const outcomes = await migrator.resumeIncomplete();
  for (const source of sources) {
    if (!(await pathExists(source))) continue;
    const outcome = await migrator.migrateSource(source);
    if (outcome.status === "conflict") {
      throw new Error("migration_conflict: legacy source conflicts with the shared registry; inspect the migration conflicts artifact");
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function publicErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  const code = message.match(/^(session_in_use|native_session_in_use|migration_blocked|migration_conflict|legacy_state_uncertain|ownership_unavailable):?/)?.[1];
  if (code) return code;
  if (message.startsWith("migration_")) return "migration_blocked";
  if (message.startsWith("ownership_")) return "ownership_unavailable";
  return message;
}

export function startupErrorMessage(error: unknown): string {
  const raw = errorMessage(error);
  if (raw.includes("caller-specific legacy state root configured")) {
    return "legacy_state_uncertain: stop all old clients, remove PI_AGENT_MCP_STATE_DIR from their configuration, start one canonical v2 client, check migration receipts, then start other clients";
  }
  switch (publicErrorMessage(error)) {
    case "ownership_unavailable":
      return "ownership_unavailable: kernel ownership requires macOS/Linux x64/arm64, Node >=22.19 <26, and the pinned flock dependency";
    case "legacy_state_uncertain":
      return "legacy_state_uncertain: stop legacy MCP clients and Pi processes, then retry one canonical startup with PI_AGENT_MCP_IMPORT_DIRTY=1";
    case "migration_conflict":
      return "migration_conflict: legacy records remain unretired; inspect the canonical migrations conflict artifact";
    case "migration_blocked":
      return "migration_blocked: another migration currently owns the source; stop duplicate migration hosts or retry later";
    case "session_in_use":
      return "session_in_use: another compliant host or inherited Pi process owns the session";
    case "native_session_in_use":
      return "native_session_in_use: another logical record owns the native Pi session";
    default:
      return errorMessage(error);
  }
}

function knownLegacyRoots(home: string): string[] {
  return [join(home, ".pi", "agent-mcp-claude"), join(home, ".pi", "agent-mcp-codex")].map((path) => resolve(path));
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
