# pi-agent-mcp

`pi-agent-mcp` exposes reusable [Pi](https://github.com/badlogic/pi-mono) coding-agent sessions to Claude Code, Codex, and other MCP clients.

Claude Code, Codex, and other local MCP hosts share one registry by default at `~/.pi/agent-mcp/`. Each logical session has an independent durable record and kernel-backed logical/native ownership locks, so different MCP servers can work on different sessions concurrently without overwriting registry state.

Each resident session owns one `pi --mode rpc` process. When a task settles, Pi stays idle and retains both ownership locks, preserving its conversation for the next `pi_send`. There is intentionally no online handoff of an idle resident session: another MCP host receives `session_in_use` until the owner shuts down gracefully.

## Requirements

- macOS or Linux, x64 or arm64; Windows and network filesystems are not supported
- Node.js `>=22.19 <26`
- `pi` installed and available on `PATH` (the v2 protocol targets Pi 0.84.1 or compatible behavior)
- A configured Pi model/provider

Ownership uses the pinned `fs-ext-extra-prebuilt@2.2.12` kernel `flock` binding. If the binding cannot load on the supported matrix, startup or the tool call fails closed with `ownership_unavailable`; there is no PID/lease fallback.

## Install and build

```sh
npm install
npm run build
```

The MCP entry point is `dist/src/index.js`. The server uses stdio: stdout is reserved for MCP messages and diagnostics go to stderr.

## Configure Claude Code

Register the built server with an absolute path. Do not set a caller-specific state directory for normal shared use:

```sh
claude mcp add --transport stdio \
  --env PI_AGENT_MCP_PI_EXECUTABLE=/opt/homebrew/bin/pi \
  pi-agent -- node /absolute/path/to/pi-agent-mcp/dist/src/index.js
```

## Configure Codex

Add the same server to `~/.codex/config.toml`, also without a state-directory override:

```toml
[mcp_servers.pi_agent]
command = "node"
args = ["/absolute/path/to/pi-agent-mcp/dist/src/index.js"]

[mcp_servers.pi_agent.env]
PI_AGENT_MCP_PI_EXECUTABLE = "/opt/homebrew/bin/pi"
```

Both clients now discover the same sessions through `~/.pi/agent-mcp/`. They may run tasks on different sessions in parallel. Only one MCP server may own a particular logical or native Pi session at a time.

### Optional isolation

`PI_AGENT_MCP_STATE_DIR=/absolute/private/path` creates an intentionally isolated registry for tests or advanced setups. Arbitrary explicit roots never import or consolidate the canonical or legacy roots. The known old roots `~/.pi/agent-mcp-claude` and `~/.pi/agent-mcp-codex` are rejected with upgrade guidance so a stale client configuration cannot silently recreate split lock namespaces. Do not give two long-lived clients different overrides when you expect them to share sessions.

## Upgrade from separate v1 roots

Older configurations commonly used `~/.pi/agent-mcp-claude/` and `~/.pi/agent-mcp-codex/`. Upgrade in this order:

1. Stop every old Claude Code/Codex MCP client and confirm their Pi RPC processes have exited.
2. Remove `PI_AGENT_MCP_STATE_DIR` from both client configurations.
3. Start one v2 client. It first resumes incomplete migration transactions, then imports `sessions.json` from the canonical, Claude, Codex, and configured legacy roots into `~/.pi/agent-mcp/`.
4. Check `pi_status` and completed receipts under `~/.pi/agent-mcp/migrations/*/receipt.json`. New migrations retire legacy manifests as deterministic `sessions.v1.retired-<content-hash>.json` files and never delete them; transactions created by earlier v2 builds retain and resume their recorded `sessions.v1.quarantine-*` paths.
5. Start the other v2 clients.

Migration is source-atomic: a conflict leaves the complete source active and returns `migration_conflict`; it never partially activates that source. `PI_AGENT_MCP_LEGACY_STATE_DIRS` may provide an OS-path-delimiter-separated list of additional legacy root directories.

If a v1 manifest has `cleanShutdown: false`, startup returns `legacy_state_uncertain`. After manually confirming all old MCP and Pi processes are stopped, run one canonical startup with `PI_AGENT_MCP_IMPORT_DIRTY=1`. This is a one-time human attestation, not automated stale-owner detection; active v1 tasks import as `host_interrupted`. Remove the variable after migration succeeds.

## Tools

The public API remains exactly five tools with the existing input shapes.

### `pi_spawn`

Creates a new Pi session and starts its first task in the background:

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

### `pi_send`

Starts the next task on an existing idle or dormant session:

```json
{
  "session_id": "pi_...",
  "task": "Continue by adding regression tests"
}
```

The same native Pi session file is reused. A session executes one task at a time. A live owner on another MCP server returns `session_in_use`; a native alias conflict returns `native_session_in_use`. After the old owner shuts down gracefully, another server can restore and send immediately.

### `pi_wait`

Waits for exact current or last task IDs:

```json
{
  "task_ids": ["task_a", "task_b", "task_c"],
  "mode": "any",
  "timeout_seconds": 60
}
```

- `mode: "any"` returns when at least one requested task is terminal.
- `mode: "all"` returns when every requested task is terminal.
- A timeout returns the terminal subset plus truthful `pending`; it does not cancel tasks.
- Local waits are event-driven. Cross-server waits poll the durable current/last slots for at most the requested timeout.
- Terminal states are `completed`, `failed`, `aborted`, and `host_interrupted`.
- If a free active record is left by a dead host, a waiter may acquire full ownership and publish `host_interrupted` without starting Pi. If an orphan Pi still holds locks, the task remains pending.
- Once a later task overwrites the record's last-task slot, the older ID returns `unknown_task`; there is no task-history registry.

### `pi_status`

With `session_id`, reads that final record from disk. With no arguments, dynamically lists all non-closed final records. Status is observational: it never acquires locks or starts Pi.

Important fields:

- `state`: durable state, overlaid by local runtime state only while this server holds live ownership at the same record revision
- `resident`: `true`/`false` for a locally owned session, or `"unknown"` for another/free owner
- `ownership`: `local`, `other`, or `free_or_unknown`; this is a diagnostic, never authorization
- `recoverable`: whether the saved native Pi session passed strict identity validation
- `current_task_id` and `last_task`: the durable current/last task slots

A corrupt final record makes `pi_status` fail clearly instead of returning a partial list.

### `pi_close`

Closes a logical session permanently:

```json
{
  "session_id": "pi_..."
}
```

For a local resident, active work becomes `aborted`, the full Pi process group is stopped, and the record becomes closed. For a free remote record with native identity, close acquires both logical and native ownership, publishes any active task as `host_interrupted`, and closes without starting Pi. An identity-less error record can only be closed under logical ownership; whenever either native identity field exists, both fields and native fencing are required. A live owner returns `session_in_use`. The native Pi JSONL file is retained.

## Errors

Ownership and migration failures use stable public codes and do not expose lock paths or lock diagnostics:

- `session_in_use`: another compliant host or inherited orphan owns the logical session
- `native_session_in_use`: another logical record owns the same actual native Pi identity
- `migration_blocked`: another migration/ownership operation currently fences the source
- `migration_conflict`: a legacy source conflicts with existing canonical records and remains unretired
- `legacy_state_uncertain`: dirty v1 state requires explicit post-shutdown attestation
- `ownership_unavailable`: the kernel lock binding or secure ownership root is unavailable

Other existing validation and lifecycle errors, including `unknown_session`, `unknown_task`, `session_busy`, and `session_not_recoverable`, retain their established meanings.

## Persistence, crash, and orphan recovery

This project implements shared logical persistence, not a daemon:

- New sessions use private per-session Pi directories and preallocated native IDs.
- Graceful shutdown stops the complete Pi process group, durably publishes `dormant`/`closed`, drains record writes, then closes ownership descriptors.
- The next MCP server lazily restores a dormant session on `pi_send` using its exact native file and identity.
- Tasks do not continue intentionally after host shutdown and are never replayed automatically.
- If the MCP parent crashes while Pi survives, Pi inherits both kernel lock descriptors. Other servers fail closed with `session_in_use` until the orphan Pi process group exits.
- To recover a permanently orphaned session, identify and terminate that Pi RPC process group, then retry `pi_wait`, `pi_send`, or `pi_close`. Never delete lock files; their contents are diagnostics only and are not stale-lock authority.

The shared registry layout is:

```text
~/.pi/agent-mcp/
  sessions/       # one atomic v2 JSON record per logical session
  pi-sessions/    # exclusive directories for newly created native sessions
  locks/          # stable 0600 logical/native/migration lock files
  migrations/     # durable source snapshots, intents, conflicts, receipts
  tmp/
```

Directories are private mode `0700`; records and lock files are mode `0600`.

## Concurrency boundary

Different Pi sessions may point at the same `cwd`, but this project does not create worktrees or prevent overlapping code edits. Give parallel sessions non-overlapping tasks or separate worktree directories. Kernel ownership prevents two compliant MCP servers from writing the same Pi session; it does not coordinate writes to the project checkout or protect against independent Pi TUI/third-party processes.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_AGENT_MCP_STATE_DIR` | `~/.pi/agent-mcp` | Advanced/test override creating an isolated registry; known old Claude/Codex roots are rejected and other explicit roots never auto-consolidate |
| `PI_AGENT_MCP_LEGACY_STATE_DIRS` | empty | Additional legacy root directories, separated by the OS path delimiter; canonical startup only |
| `PI_AGENT_MCP_IMPORT_DIRTY` | unset | Set to `1` for one canonical startup after manually stopping all old writers |
| `PI_AGENT_MCP_PI_EXECUTABLE` | `pi` | Pi executable path or command |
| `PI_AGENT_MCP_MAX_SESSIONS` | `16` | Maximum active Pi processes in this MCP server |
| `PI_AGENT_MCP_COMMAND_TIMEOUT_MS` | `30000` | Timeout for one Pi RPC command response |
| `PI_AGENT_MCP_SHUTDOWN_GRACE_MS` | `1000` | Grace period before force-killing Pi |

## Development

```sh
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

Tests use temporary roots and a controllable fake Pi; they never read or write the user's real `~/.pi` data or call a model API. Coverage includes RPC framing, process-group cleanup, per-record atomicity, source-atomic migration, kernel ownership inheritance, cross-server status/wait/send/close behavior, and the unchanged five-tool MCP surface.
