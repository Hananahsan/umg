# umg0 examples

Copy-paste configs, prompts, and playbooks for **UMG** (package/CLI brand: **umg0**).  
Same stdio MCP server everywhere — only the host config path changes.

## Install (preferred)

No clone path required once published:

```bash
# smoke test
npx -y @umg0/umg0 retain --content "Prefer TypeScript strict mode" --tier semantic
npx -y @umg0/umg0 recall --query "TypeScript"
npx -y @umg0/umg0 stats
```

**MCP block** (Claude Code, Cursor, VS Code, most hosts):

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

Faster cold start after global install:

```bash
npm install -g @umg0/umg0
# command: "umg0", args: ["mcp"]
```

**From this repo (before publish / offline):**

```bash
git clone https://github.com/Hananahsan/umg.git
cd umg && npm install && npm run build
npm install -g .    # provides umg0 on PATH
# or: node dist/index.js mcp
```

Optional env:

| Variable | Purpose |
|----------|---------|
| `UMG_DB_PATH` | SQLite path (default `~/.umg/memory.db`; use an absolute path if you set it — many hosts do not expand `~`) |
| `UMG_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `UMG_NAMESPACE` | Default namespace |
| `UMG_HARD_ISOLATION` | `true` to force namespace on recall |

**Single-writer:** one MCP process per database file. Share the same config across tools; do not spawn multiple writers on one DB.

After editing config, **restart** the client so it reloads MCP servers.

---

## Client configs

| File | Client(s) | Where to put it |
|------|-----------|-----------------|
| [claude-code.mcp.json](./claude-code.mcp.json) | Claude Code | Merge into `~/.claude.json` or project `.mcp.json` under `mcpServers` |
| [cursor.mcp.json](./cursor.mcp.json) | Cursor | `~/.cursor/mcp.json` (or Cursor Settings → MCP) |
| [hermes.config.snippet.yaml](./hermes.config.snippet.yaml) | Hermes Agent | Merge into Hermes MCP / agent config (`mcp_servers`) |
| [vscode-cline.mcp.json](./vscode-cline.mcp.json) | VS Code + Copilot, Cline, Roo Code, many others | Host MCP JSON settings |

Zed, Windsurf, and ChatGPT Developer Mode (MCP) typically use the same stdio command — check that host’s docs for the config path.

---

## Agent prompts & playbooks (start here)

| File | Purpose |
|------|---------|
| [session-start.md](./session-start.md) | **Every session open** — recall playbook |
| [session-end.md](./session-end.md) | **Every session close** — reflect checklist |
| [coding-agent-prompt.md](./coding-agent-prompt.md) | Strong system prompt for Claude Code / Cursor / Cline |
| [agent-system-prompt.md](./agent-system-prompt.md) | Shorter general agent prompt |
| [workflows/daily-coding.md](./workflows/daily-coding.md) | Full day tool-call sequences |
| [skill-promotion.md](./skill-promotion.md) | When/how to promote; good vs bad skills |
| [anti-patterns.md](./anti-patterns.md) | What **not** to retain |
| [namespaces.md](./namespaces.md) | `project:`, `client:`, `personal:`, isolation |
| [claude-code-hooks.md](./claude-code-hooks.md) | Optional Stop-hook write-back |
| [hooks/session-end-reflect.sh](./hooks/session-end-reflect.sh) | Shell helper for hooks |

**Recommended path for a coding agent:** paste `coding-agent-prompt.md` → follow `session-start.md` / `session-end.md` → use `workflows/daily-coding.md` as the day shape.

---

## From-source fallback (absolute path)

Only if you are not using npx/global install:

```json
{
  "mcpServers": {
    "umg": {
      "command": "node",
      "args": ["/absolute/path/to/umg/dist/index.js", "mcp"],
      "env": {
        "UMG_LOG_LEVEL": "info"
      }
    }
  }
}
```
