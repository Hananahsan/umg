#!/usr/bin/env bash
# umg0 session-end helper for Claude Code Stop hooks (optional).
# Prefer agent MCP reflect with real bullets; this is a best-effort fallback.
set -euo pipefail

UMG_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="${UMG_DB_PATH:-$HOME/.umg/memory.db}"
NS="${UMG_NAMESPACE:-global}"
NOTES_FILE="${UMG_SESSION_NOTES:-$HOME/.umg/last-session-notes.txt}"

export UMG_DB_PATH="$DB"
export UMG_SKIP_STARTUP_PRUNE="${UMG_SKIP_STARTUP_PRUNE:-1}"

# Prefer UMG0_BIN, then umg0 on PATH, then local dist / tsx, then npx
if [[ -n "${UMG0_BIN:-}" ]]; then
  RUNNER=($UMG0_BIN)
elif command -v umg0 >/dev/null 2>&1; then
  RUNNER=(umg0)
elif [[ -f "$UMG_ROOT/dist/index.js" ]]; then
  RUNNER=(node "$UMG_ROOT/dist/index.js")
elif [[ -f "$UMG_ROOT/src/index.ts" ]]; then
  RUNNER=(npx tsx "$UMG_ROOT/src/index.ts")
else
  RUNNER=(npx -y @umg0/umg0)
fi

if [[ -f "$NOTES_FILE" && -s "$NOTES_FILE" ]]; then
  TEXT="$(cat "$NOTES_FILE")"
else
  TEXT="Session end marker. Prefer MCP reflect with real decisions and preferences."
fi

"${RUNNER[@]}" reflect --text "$TEXT" --namespace "$NS" >/dev/null 2>&1 || true
