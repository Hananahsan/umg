# UMG examples

Copy-paste configs for common **MCP clients**. UMG speaks **stdio MCP** — the server process is the same everywhere; only where you paste the config changes.

## Prerequisites

```bash
cd /absolute/path/to/umg
npm install && npm run build
```

Replace `/absolute/path/to/umg` in every config with your real clone path.

Optional env:

| Variable | Purpose |
|----------|---------|
| `UMG_DB_PATH` | SQLite path (default `~/.umg/memory.db`) |
| `UMG_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

**Single-writer:** one MCP process per database file. Share the same config across tools; do not spawn multiple writers on one DB.

---

## Which file for which client?

| File | Client(s) | Where to put it |
|------|-----------|-----------------|
| [claude-code.mcp.json](./claude-code.mcp.json) | Claude Code | Merge into `~/.claude.json` or project `.mcp.json` under `mcpServers` |
| [cursor.mcp.json](./cursor.mcp.json) | Cursor | `~/.cursor/mcp.json` (or Cursor Settings → MCP) |
| [hermes.config.snippet.yaml](./hermes.config.snippet.yaml) | Hermes Agent | Merge into Hermes MCP / agent config (`mcp_servers`) |
| [vscode-cline.mcp.json](./vscode-cline.mcp.json) | VS Code + Copilot, Cline, Roo Code, many others | Host MCP JSON settings (shape is standard `mcpServers`) |
| [agent-system-prompt.md](./agent-system-prompt.md) | Any agent | Paste into system / custom instructions |
| [claude-code-hooks.md](./claude-code-hooks.md) | Claude Code (advanced) | Optional Stop-hook write-back |
| [hooks/session-end-reflect.sh](./hooks/session-end-reflect.sh) | Claude Code hooks | Optional shell helper |

Zed, Windsurf, and ChatGPT Developer Mode (MCP) typically use the **same stdio command** as the generic JSON — check that host’s docs for the exact config file path.

---

## Minimal server block

```json
{
  "mcpServers": {
    "umg": {
      "command": "node",
      "args": ["/absolute/path/to/umg/dist/index.js", "mcp"],
      "env": {
        "UMG_DB_PATH": "/absolute/path/to/home/.umg/memory.db"
      }
    }
  }
}
```

After editing, **restart** the client so it reloads MCP servers.
