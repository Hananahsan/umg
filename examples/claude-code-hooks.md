# Claude Code hooks — UMG write-back

UMG does not silently store full transcripts. The portable write-back primitive is **`reflect`**.  
Claude Code can call that at session end via a **Stop** (or SessionEnd) hook.

## 1. MCP server

Ensure UMG is registered (see `examples/claude-code.mcp.json`):

```json
{
  "mcpServers": {
    "umg": {
      "command": "node",
      "args": ["/Users/hananahsan/umg/dist/index.js", "mcp"],
      "env": {
        "UMG_DB_PATH": "/Users/hananahsan/.umg/memory.db"
      }
    }
  }
}
```

## 2. Optional Stop hook (shell helper)

Create `~/.umg/hooks/session-end-reflect.sh`:

```bash
#!/usr/bin/env bash
# Best-effort session write-back via CLI reflect.
# Claude Code Stop hooks receive JSON on stdin; we keep this simple and optional.
set -euo pipefail

UMG_BIN="${UMG_BIN:-/Users/hananahsan/umg/dist/index.js}"
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

node "$UMG_BIN" reflect --text "$TEXT" --namespace "$NS" 2>/dev/null || true
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
            "command": "/Users/YOUR_USER/.umg/hooks/session-end-reflect.sh"
          }
        ]
      }
    ]
  }
}
```

> Hook shapes evolve with Claude Code. Prefer the agent calling MCP `reflect` with real session bullets when possible — that is higher quality than a generic shell fallback.

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

Or load the MCP prompt `session-start` with project/task args.
