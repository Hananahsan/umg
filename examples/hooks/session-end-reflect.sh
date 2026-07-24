#!/usr/bin/env bash
# UMG session-end helper for Claude Code Stop hooks (optional).
# Prefer agent MCP reflect with real bullets; this is a best-effort fallback.
set -euo pipefail

UMG_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UMG_BIN="${UMG_BIN:-$UMG_ROOT/dist/index.js}"
if [[ ! -f "$UMG_BIN" ]]; then
  UMG_BIN="$UMG_ROOT/src/index.ts"
  RUNNER=(npx tsx)
else
  RUNNER=(node)
fi

DB="${UMG_DB_PATH:-$HOME/.umg/memory.db}"
NS="${UMG_NAMESPACE:-global}"
NOTES_FILE="${UMG_SESSION_NOTES:-$HOME/.umg/last-session-notes.txt}"

export UMG_DB_PATH="$DB"
export UMG_SKIP_STARTUP_PRUNE="${UMG_SKIP_STARTUP_PRUNE:-1}"

if [[ -f "$NOTES_FILE" && -s "$NOTES_FILE" ]]; then
  TEXT="$(cat "$NOTES_FILE")"
else
  TEXT="Session end marker. Prefer MCP reflect with real decisions and preferences."
fi

"${RUNNER[@]}" "$UMG_BIN" reflect --text "$TEXT" --namespace "$NS" >/dev/null 2>&1 || true
