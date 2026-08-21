# Pi Agent MCP

[![npm](https://img.shields.io/npm/v/@pathli/pi-agent-mcp)](https://www.npmjs.com/package/@pathli/pi-agent-mcp)
[![CI](https://github.com/a809384377/path_pi/actions/workflows/ci.yml/badge.svg)](https://github.com/a809384377/path_pi/actions/workflows/ci.yml)

A local stdio MCP server that lets Claude Code, Codex, and other MCP hosts run multiple persistent [Pi Coding Agent](https://github.com/badlogic/pi-mono) sessions.

The npm package contains the MCP server and `skills/pi-agent/SKILL.md`. It does **not** include Pi, model credentials, or a configuration manager. Installation never modifies MCP Host settings or user Skill directories.

## Requirements

- Pi Coding Agent `>=0.84.1 <0.85.0`, installed and authenticated
- Node.js `>=22.19 <26`
- macOS or Linux on x64 or arm64
- A local filesystem for `~/.pi/agent-mcp`; network filesystems are unsupported

Verify Pi before installing:

```sh
pi --version
pi
# Run /login if Pi has no authenticated model provider.
```

## Install

Install the MCP server globally:

```sh
npm install -g @pathli/pi-agent-mcp@0.1.0
command -v pi-agent-mcp
command -v pi
```

Register it explicitly with each MCP Host you want to use. Replace `/absolute/path/to/pi` with the result of `command -v pi`.

### Claude Code

```sh
claude mcp add --scope user --transport stdio \
  --env PI_AGENT_MCP_PI_EXECUTABLE=/absolute/path/to/pi \
  pi-agent -- pi-agent-mcp
```

### Codex

```sh
codex mcp add \
  --env PI_AGENT_MCP_PI_EXECUTABLE=/absolute/path/to/pi \
  pi-agent -- pi-agent-mcp
```

These Host commands may reject or replace an existing `pi-agent` registration according to the Host's own behavior. Review any existing registration before running them.

## Install the Skill

The Skill is optional. Locate the global npm package and copy its static file explicitly:

```sh
PACKAGE_ROOT="$(npm root -g)/@pathli/pi-agent-mcp"
```

For Claude Code, install only when no file already exists:

```sh
CLAUDE_SKILL="$HOME/.claude/skills/pi-agent/SKILL.md"
if [ -e "$CLAUDE_SKILL" ]; then
  printf 'Preserved existing Skill: %s\n' "$CLAUDE_SKILL" >&2
else
  mkdir -p "$(dirname "$CLAUDE_SKILL")"
  install -m 0644 "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" "$CLAUDE_SKILL"
fi
```

For Codex, install only when no file already exists:

```sh
CODEX_SKILL="$HOME/.agents/skills/pi-agent/SKILL.md"
if [ -e "$CODEX_SKILL" ]; then
  printf 'Preserved existing Skill: %s\n' "$CODEX_SKILL" >&2
else
  mkdir -p "$(dirname "$CODEX_SKILL")"
  install -m 0644 "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" "$CODEX_SKILL"
fi
```

The commands preserve existing Skill files. Compare an existing file with the packaged source and replace it only after reviewing the differences. Restart the Host after registration or Skill changes. Invoke `/pi-agent` in Claude Code, `$pi-agent` in Codex, or ask the Host to use Pi Agent.

## Update

Update the npm package first:

```sh
npm install -g @pathli/pi-agent-mcp@latest
PACKAGE_ROOT="$(npm root -g)/@pathli/pi-agent-mcp"
```

If you previously installed a Skill, review the packaged changes before replacing it. For Claude Code:

```sh
diff -u \
  "$HOME/.claude/skills/pi-agent/SKILL.md" \
  "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" || true
```

Only after reviewing that output, explicitly replace the Claude Skill:

```sh
install -m 0644 \
  "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" \
  "$HOME/.claude/skills/pi-agent/SKILL.md"
```

For Codex, use the same two-step review and replacement:

```sh
diff -u \
  "$HOME/.agents/skills/pi-agent/SKILL.md" \
  "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" || true
```

Only after reviewing that output, explicitly replace the Codex Skill:

```sh
install -m 0644 \
  "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" \
  "$HOME/.agents/skills/pi-agent/SKILL.md"
```

The npm package never rewrites Host registrations or Skill files during updates.

## Uninstall

Remove Host registrations explicitly. Then remove a Skill only when it is byte-for-byte identical to the file in the currently installed npm package:

```sh
claude mcp remove pi-agent --scope user
codex mcp remove pi-agent

PACKAGE_ROOT="$(npm root -g)/@pathli/pi-agent-mcp"
for SKILL_FILE in \
  "$HOME/.claude/skills/pi-agent/SKILL.md" \
  "$HOME/.agents/skills/pi-agent/SKILL.md"
do
  if [ -e "$SKILL_FILE" ] && cmp -s "$PACKAGE_ROOT/skills/pi-agent/SKILL.md" "$SKILL_FILE"; then
    rm -- "$SKILL_FILE"
    rmdir "$(dirname "$SKILL_FILE")" 2>/dev/null || true
  elif [ -e "$SKILL_FILE" ]; then
    printf 'Preserved modified Skill: %s\n' "$SKILL_FILE" >&2
  fi
done

npm uninstall -g @pathli/pi-agent-mcp
```

Run only the Host removal commands you actually configured. The Skill loop preserves modified files and any other files in the Skill directory. These commands intentionally preserve `~/.pi/agent-mcp`, Pi authentication, and native Pi sessions. To remove state, first stop every MCP Host and Pi worker, back up anything needed, and delete the state directory yourself.

## Other MCP Hosts

Run `pi-agent-mcp` with no arguments as a stdio MCP server. A generic configuration is:

```json
{
  "mcpServers": {
    "pi-agent": {
      "command": "pi-agent-mcp",
      "args": [],
      "env": {
        "PI_AGENT_MCP_PI_EXECUTABLE": "/absolute/path/to/pi"
      }
    }
  }
}
```

Install globally when possible because the package uses a prebuilt native ownership binding. If a Host launches it through `npx`, ensure npm lifecycle scripts are not disabled and pin a tested package version:

```json
{
  "command": "npx",
  "args": ["-y", "@pathli/pi-agent-mcp@0.1.0"]
}
```

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `pi_spawn` | Create a persistent Pi session and start its first task |
| `pi_send` | Continue an idle or dormant session with preserved context |
| `pi_wait` | Wait for one or all exact task IDs to reach a terminal state |
| `pi_status` | Inspect one session or list all non-closed sessions |
| `pi_close` | Permanently close a logical session and stop its process tree |

The default shared registry is `~/.pi/agent-mcp`. Different hosts can run different sessions concurrently, but only one MCP server can own a particular logical/native Pi session at a time.

`pi_wait` has no application timeout. Cancelling the MCP request stops only that wait; it does not cancel the Pi task.

## Security

This server launches Pi with the current user's privileges. Pi can read and modify files, run commands, access inherited environment variables, and consume model-provider quota. It is not a sandbox.

- Review tasks and requested working directories before approval.
- Do not install untrusted Skills or MCP packages.
- Do not put API keys in MCP registration commands.
- The package never copies `auth.json`, `models.json`, API keys, or Pi session files.
- Shared registry permissions isolate other OS users, not other trusted MCP hosts running as the same user.
- Report security vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/a809384377/path_pi/security/advisories/new); do not open a public issue for unpatched vulnerabilities.
- Session ownership does not prevent different Pi sessions from editing the same checkout. Use non-overlapping tasks or separate Git worktrees.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_AGENT_MCP_PI_EXECUTABLE` | `pi` | Pi executable path or command |
| `PI_AGENT_MCP_STATE_DIR` | `~/.pi/agent-mcp` | Advanced isolated registry override |
| `PI_AGENT_MCP_LEGACY_STATE_DIRS` | empty | Additional legacy v1 roots separated by the OS path delimiter |
| `PI_AGENT_MCP_IMPORT_DIRTY` | unset | One-time `1` migration attestation after old processes are stopped |
| `PI_AGENT_MCP_MAX_SESSIONS` | `16` | Maximum resident Pi processes per MCP server |
| `PI_AGENT_MCP_COMMAND_TIMEOUT_MS` | `30000` | Timeout for one Pi RPC command response |
| `PI_AGENT_MCP_SHUTDOWN_GRACE_MS` | `1000` | Grace period before force-killing Pi |

## Development

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

Tests use temporary directories and a fake Pi executable. They do not read real credentials, call model APIs, or modify `~/.pi`.

## License

MIT
