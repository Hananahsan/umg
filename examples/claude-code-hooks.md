# Claude Code hooks — umg0 write-back

UMG does not silently store full transcripts. The portable write-back primitive is **`reflect`**.  
Claude Code can call that at session end via a **Stop** (or SessionEnd) hook.

## 1. MCP server

Ensure umg0 is registered (see `examples/claude-code.mcp.json`):

```json
{
  "mcpServers": {
    "umg": {
      "command": "npx",
      "args": ["-y", "@umg0/umg0", "mcp"],
      "env": {
        "UMG_LOG_LEVEL": "info"
      }
    }
  }
}
```

Faster cold start after `npm i -g @umg0/umg0` (or `npm i -g .` from a clone):

```json
{
  "command": "umg0",
  "args": ["mcp"]
}
```

## 2. Optional Stop hook (shell helper)

Create `~/.umg/hooks/session-end-reflect.sh`:

```bash
#!/usr/bin/env bash
# Best-effort session write-back via CLI reflect.
# Claude Code Stop hooks receive JSON on stdin; we keep this simple and optional.
set -euo pipefail

# Prefer global bin; fall back to npx; override with UMG0_BIN if needed
UMG0_BIN="${UMG0_BIN:-}"
if [[ -z "$UMG0_BIN" ]]; then
  if command -v umg0 >/dev/null 2>&1; then
    UMG0_BIN="umg0"
  else
    UMG0_BIN="npx -y @umg0/umg0"
  fi
fi

DB="${UMG_DB_PATH:-$HOME/.umg/memory.db}"
NS="${UMG_NAMESPACE:-global}"

# Prefer an explicit notes file if the agent wrote one this session
NOTES_FILE="${UMG_SESSION_NOTES:-$HOME/.umg/last-session-notes.txt}"

if [[ -f "$NOTES_FILE" && -s "$NOTES_FILE" ]]; then
  TEXT="$(cat "$NOTES_FILE")"
else
  # Minimal fallback — agent should call reflect via MCP for quality extraction
  TEXT="Session end: prefer agent-driven reflect via MCP with real decisions/preferences."
fi

export UMG_DB_PATH="$DB"
# shellcheck disable=SC2086
$UMG0_BIN reflect --text "$TEXT" --namespace "$NS" 2>/dev/null || true
```

```bash
chmod +x ~/.umg/hooks/session-end-reflect.sh
```

Example Claude Code settings hook fragment (`~/.claude/settings.json` or project settings):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$HOME/.umg/hooks/session-end-reflect.sh"
          }
        ]
      }
    ]
  }
}
```

> Hook shapes evolve with Claude Code. Prefer the agent calling MCP `reflect` with real session bullets when possible — that is higher quality than a generic shell fallback. See [session-end.md](./session-end.md).

## 3. Recommended agent pattern (primary)

At session end, the agent should:

1. List decisions / preferences / corrections as short bullets  
2. Call MCP tool **`reflect`** with that text (`auto_retain: true`)  
3. Optionally **`prune`** with `dry_run: true` if many low-value items were stored  

Use MCP prompts:

- `memory-usage` — full tool guidance  
- `session-start` — load prior memory  
- `session-end` — write-back checklist  

## 4. Session-start

At the start of a coding session:

```
recall(query: "<project> <task>", namespace: "project:<name>")
```

Or load the MCP prompt `session-start` with project/task args. See [session-start.md](./session-start.md).
