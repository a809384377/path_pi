# pi-agent-mcp

`pi-agent-mcp` exposes reusable [Pi](https://github.com/badlogic/pi-mono) coding-agent sessions to Claude Code, Codex, and other MCP clients.

Each logical session owns one `pi --mode rpc` process while the MCP host is running. Different sessions work in parallel. When a task settles, the Pi process stays idle and the same session can receive another task with its prior conversation and code context intact.

## Requirements

- Node.js 20 or newer
- `pi` installed and available on `PATH`
- A configured Pi model/provider

## Install and build

```sh
npm install
npm run build
```

The MCP entry point is `dist/src/index.js`. The server uses stdio: stdout is reserved for MCP messages and diagnostics go to stderr.

## Configure Claude Code

From any directory, register the built server with an absolute path:

```sh
claude mcp add --transport stdio pi-agent -- \
  node /absolute/path/to/pi-agent-mcp/dist/src/index.js
```

To use an explicit state directory or Pi executable:

```sh
claude mcp add --transport stdio \
  --env PI_AGENT_MCP_STATE_DIR=/Users/me/.pi/agent-mcp-claude \
  --env PI_AGENT_MCP_PI_EXECUTABLE=/opt/homebrew/bin/pi \
  pi-agent -- node /absolute/path/to/pi-agent-mcp/dist/src/index.js
```

## Configure Codex

Add the server to `~/.codex/config.toml`:

```toml
[mcp_servers.pi_agent]
command = "node"
args = ["/absolute/path/to/pi-agent-mcp/dist/src/index.js"]

[mcp_servers.pi_agent.env]
PI_AGENT_MCP_STATE_DIR = "/Users/me/.pi/agent-mcp-codex"
PI_AGENT_MCP_PI_EXECUTABLE = "/opt/homebrew/bin/pi"
```

Claude Code and Codex must use different `PI_AGENT_MCP_STATE_DIR` values if they run at the same time. The manifest is intentionally single-writer.

## Tools

### `pi_spawn`

Creates a new Pi session and starts its first task. It returns immediately:

```json
{
  "task": "Inspect the authentication module and fix token refresh",
  "cwd": "/Users/me/project",
  "name": "auth-worker",
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

```json
{
  "session_id": "pi_...",
  "task_id": "task_...",
  "status": "running"
}
```

`name` and `model` are optional. `cwd` must be an existing absolute directory.

### `pi_wait`

Waits for immutable task IDs. Results are observational, not consumed, so callers may wait for the same task more than once.

```json
{
  "task_ids": ["task_a", "task_b", "task_c"],
  "mode": "any",
  "timeout_seconds": 60
}
```

- `mode: "any"` returns when at least one requested task is terminal.
- `mode: "all"` returns when every requested task is terminal.
- A timeout returns the terminal subset plus `pending`; it does not cancel or fail tasks.
- Task terminal states are `completed`, `failed`, `aborted`, and `host_interrupted`.

### `pi_send`

Starts the next task on an existing idle or dormant session:

```json
{
  "session_id": "pi_...",
  "task": "Continue by adding regression tests for the refresh fix"
}
```

The same Pi session file is reused, so the worker remembers previous turns. A session executes one task at a time; sending while it is restoring, dispatching, or running returns `session_busy` rather than queueing work.

### `pi_status`

With a `session_id`, returns one session. With no arguments, lists all non-closed sessions. Status is observational and does not wake a dormant Pi process.

Important fields:

- `state`: `dormant`, `restoring`, `dispatching`, `running`, `idle`, `error`, `closing`, or `closed`
- `resident`: whether an OS process currently exists
- `recoverable`: whether the saved Pi session may be resumed
- `current_task_id` and `last_task`

### `pi_close`

Closes a logical session permanently. An active task becomes `aborted`, waiters wake, and the owned Pi process tree is stopped. The native Pi session file is retained.

## Recommended agent workflow

1. Call `pi_spawn` once per independent workstream.
2. Start all desired sessions before waiting, so they run in parallel.
3. Call `pi_wait` with `mode: "any"` to process results as workers finish, or `mode: "all"` at a synchronization point.
4. Call `pi_send` with the same `session_id` when that worker should continue related work.
5. Call `pi_close` when the session is no longer useful.

Example:

```text
spawn(auth) ─┐
spawn(tests) ├─ run concurrently ─ wait(any) ─ send(completed session) ─ wait(...)
spawn(docs) ─┘
```

## Persistence and shutdown boundary

This project implements **logical persistence**, not a daemon:

- While Claude Code or Codex keeps the MCP server alive, completed Pi processes remain idle in the background.
- On a graceful MCP shutdown, active tasks become `host_interrupted`, child processes are stopped, and Pi session file mappings are saved.
- On the next server start, cleanly saved sessions appear as `dormant` and are lazily restored by the next `pi_send`.
- Tasks do **not** continue after the MCP host exits and are never automatically replayed.
- After an unclean host crash, dirty sessions are not automatically restored because an old process cannot be proven dead without a daemon or lease.

The default manifest is `~/.pi/agent-mcp/sessions.json`. Writes use a temporary file and atomic rename.

## Concurrency warning

Different Pi sessions may point at the same `cwd`, but this MVP does not create worktrees, lock files, or prevent overlapping edits. Give parallel sessions non-overlapping tasks or separate worktree directories. The main Agent remains responsible for coordinating writes.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_AGENT_MCP_STATE_DIR` | `~/.pi/agent-mcp` | Manifest directory; one MCP server writer only |
| `PI_AGENT_MCP_PI_EXECUTABLE` | `pi` | Pi executable path or command |
| `PI_AGENT_MCP_MAX_SESSIONS` | `16` | Maximum active Pi processes; dormant history does not consume a slot |
| `PI_AGENT_MCP_COMMAND_TIMEOUT_MS` | `30000` | Timeout for one Pi RPC command response |
| `PI_AGENT_MCP_SHUTDOWN_GRACE_MS` | `1000` | Grace period before force-killing Pi |

## Development

```sh
npm run typecheck
npm run build
npm test
```

Tests use a controllable fake Pi executable and never call a model API. They cover JSONL framing, RPC correlation and failure, parallel sessions, reusable context, wait semantics, crash/close/shutdown races, atomic persistence, lazy restoration, and all five MCP tools.
