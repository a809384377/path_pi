#!/usr/bin/env bash
set -eo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [options]

Build pi-agent-mcp and optionally configure MCP hosts and the pi-agent Skill.

Options:
  --host claude|codex|all|none   MCP host to configure (default: all detected)
  --skill-dir PATH              Install Skill only into PATH
  --skip-skill                  Do not install the pi-agent Skill
  --skip-build                  Do not run npm install/build
  --force                       Replace existing Skill symlinks/MCP registrations
  -h, --help                    Show this help

Without --skill-dir, the Skill is installed into ~/.claude/skills for Claude
Code and ~/.agents/skills for Codex. Existing real files/directories are never
deleted. The script never copies models.json, settings.json, auth.json, API
keys, or Pi sessions.
EOF
}

HOST="auto"
CUSTOM_SKILL_DIR=""
INSTALL_SKILL=1
BUILD=1
FORCE=0

while (($#)); do
  case "$1" in
    --host)
      [[ $# -ge 2 ]] || { echo "--host requires a value" >&2; exit 2; }
      HOST="$2"
      shift 2
      ;;
    --skill-dir)
      [[ $# -ge 2 ]] || { echo "--skill-dir requires a value" >&2; exit 2; }
      CUSTOM_SKILL_DIR="$2"
      shift 2
      ;;
    --skip-skill) INSTALL_SKILL=0; shift ;;
    --skip-build) BUILD=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$HOST" in
  auto|claude|codex|all|none) ;;
  *) echo "Invalid --host value: $HOST" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PI_EXECUTABLE="$(command -v pi || true)"
NODE_EXECUTABLE="$(command -v node || true)"

if [[ -z "$PI_EXECUTABLE" ]]; then
  echo "pi was not found on PATH. Install Pi first; see docs/INSTALL.zh-CN.md." >&2
  exit 1
fi
if [[ -z "$NODE_EXECUTABLE" ]]; then
  echo "node was not found on PATH. Node.js >=22.19 and <26 is required." >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19) || major >= 26) process.exit(1)' || {
  echo "Unsupported Node.js $(node --version); expected >=22.19 and <26." >&2
  exit 1
}

hosts=()
case "$HOST" in
  auto)
    command -v claude >/dev/null 2>&1 && hosts+=(claude)
    command -v codex >/dev/null 2>&1 && hosts+=(codex)
    ;;
  all) hosts=(claude codex) ;;
  none) hosts=() ;;
  *) hosts=("$HOST") ;;
esac

for host in "${hosts[@]}"; do
  if ! command -v "$host" >/dev/null 2>&1; then
    echo "$host was requested but is not installed." >&2
    exit 1
  fi
  if "$host" mcp get pi-agent >/dev/null 2>&1 && [[ "$FORCE" -ne 1 ]]; then
    echo "$host already has an MCP server named pi-agent; use --force to replace it." >&2
    exit 1
  fi
done

skill_dirs=()
if ((INSTALL_SKILL)); then
  if [[ -n "$CUSTOM_SKILL_DIR" ]]; then
    skill_dirs+=("$CUSTOM_SKILL_DIR")
  elif ((${#hosts[@]} == 0)); then
    skill_dirs+=("${HOME}/.agents/skills")
  else
    for host in "${hosts[@]}"; do
      case "$host" in
        claude) candidate="${HOME}/.claude/skills" ;;
        codex) candidate="${HOME}/.agents/skills" ;;
      esac
      seen=0
      for existing in "${skill_dirs[@]}"; do
        [[ "$existing" == "$candidate" ]] && seen=1
      done
      ((seen == 1)) || skill_dirs+=("$candidate")
    done
  fi

  SOURCE_SKILL="$ROOT/skills/pi-agent"
  for skill_dir in "${skill_dirs[@]}"; do
    target="$skill_dir/pi-agent"
    if [[ -e "$target" || -L "$target" ]]; then
      if [[ ! -L "$target" ]]; then
        echo "Refusing to replace real file or directory at $target; move it manually first." >&2
        exit 1
      fi
      resolved="$(cd "$target" 2>/dev/null && pwd -P || true)"
      if [[ "$resolved" == "$SOURCE_SKILL" ]]; then
        continue
      fi
      if [[ "$FORCE" -ne 1 ]]; then
        echo "Skill symlink already exists at $target; use --force to replace the link." >&2
        exit 1
      fi
    fi
  done
fi

if ((BUILD)); then
  if [[ -f "$ROOT/package-lock.json" ]]; then
    npm --prefix "$ROOT" ci
  else
    npm --prefix "$ROOT" install
  fi
  npm --prefix "$ROOT" run build
fi

ENTRY="$ROOT/dist/src/index.js"
[[ -f "$ENTRY" ]] || {
  echo "Missing $ENTRY. Re-run without --skip-build." >&2
  exit 1
}

if ((INSTALL_SKILL)); then
  for skill_dir in "${skill_dirs[@]}"; do
    target="$skill_dir/pi-agent"
    mkdir -p "$skill_dir"
    if [[ -e "$target" || -L "$target" ]]; then
      resolved="$(cd "$target" 2>/dev/null && pwd -P || true)"
      if [[ "$resolved" == "$SOURCE_SKILL" ]]; then
        echo "Skill already installed: $target"
        continue
      fi
      rm "$target"
    fi
    ln -s "$SOURCE_SKILL" "$target"
    echo "Installed Skill: $target -> $SOURCE_SKILL"
  done
fi

for host in "${hosts[@]}"; do
  if "$host" mcp get pi-agent >/dev/null 2>&1; then
    if [[ "$host" == "claude" ]]; then
      claude mcp remove pi-agent >/dev/null
    else
      codex mcp remove pi-agent >/dev/null
    fi
  fi

  if [[ "$host" == "claude" ]]; then
    claude mcp add --scope user --transport stdio \
      --env "PI_AGENT_MCP_PI_EXECUTABLE=$PI_EXECUTABLE" \
      pi-agent -- "$NODE_EXECUTABLE" "$ENTRY"
  else
    codex mcp add --env "PI_AGENT_MCP_PI_EXECUTABLE=$PI_EXECUTABLE" \
      pi-agent -- "$NODE_EXECUTABLE" "$ENTRY"
  fi
  echo "Configured $host MCP server: pi-agent"
done

if ((${#hosts[@]} == 0)); then
  echo "No MCP host configured. Use --host claude, --host codex, or --host all later."
fi

echo "Done. Restart each configured host. Invoke /pi-agent in Claude Code or \$pi-agent in Codex."
