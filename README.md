# umg0 — Unified Memory Gateway

MCP-first, local-first hierarchical memory for AI agents.  
Think **“OpenRouter for agent memory”** — hierarchical local memory with **gateway architecture ready**.

Works with **Claude Code, Cursor, Hermes, Cline, Roo Code, VS Code + GitHub Copilot, Zed, Windsurf, ChatGPT (Developer Mode), and any MCP-compatible client.** Same stdio MCP server; only the config file location changes.

**Brand / npm / CLI:** **umg0** · **Product name:** UMG (Unified Memory Gateway) · Marketing site: **[site/](./site/)**

**Problem it solves:** agent amnesia and the re-explanation tax, without unbounded memory bloat.

**v0.2 positioning:** multi-backend routing is **out of scope**. One excellent local store + clean `MemoryStore` port. Transport is **stdio MCP** today (remote/HTTP is future work).

> npm package name is **`@umg0/umg0`** (binary `umg0`) because bare `umg` is taken and unscoped `umg0` is blocked as too similar to `umi` on the registry. Product and env prefix stay **UMG** (`UMG_DB_PATH`, etc.).

## Works with

| Client | Config location (typical) | Example file |
|--------|---------------------------|--------------|
| **Claude Code** | `~/.claude.json` or project `.mcp.json` | [examples/claude-code.mcp.json](./examples/claude-code.mcp.json) |
| **Cursor** | `~/.cursor/mcp.json` | [examples/cursor.mcp.json](./examples/cursor.mcp.json) |
| **Hermes** | Hermes MCP / `mcp_servers` config | [examples/hermes.config.snippet.yaml](./examples/hermes.config.snippet.yaml) |
| **Cline / Roo Code** | Cline / Roo MCP settings (JSON) | [examples/vscode-cline.mcp.json](./examples/vscode-cline.mcp.json) |
| **VS Code + GitHub Copilot** | VS Code MCP / Copilot MCP config | [examples/vscode-cline.mcp.json](./examples/vscode-cline.mcp.json) |
| **Zed** | Zed agent MCP settings | Same generic `mcpServers` shape |
| **Windsurf** | Windsurf MCP config | Same generic shape |
| **ChatGPT (Developer Mode)** | MCP tool config where enabled | Same stdio server |
| **Any MCP client** | Whatever that host uses for stdio MCP | Generic block below |

See [examples/README.md](./examples/README.md) for configs, session playbooks, and system prompts.

## Features (v0.2)

- **MCP tools:** `retain`, `recall`, `reflect`, `list_memories`, `prune`, `promote_to_skill` (+ `dry_run`)
- **Hierarchy:** working → episodic → semantic → procedural
- **Configurable ranking** (FTS, importance, decay, tier, recency, entity)
- **Additive-first writes** with confidence-gated supersede
- **Multi-pass prune**, promotion quality gates, 7-day metrics
- **Local SQLite** (WAL, offline by default); optional hybrid embeddings behind a flag

## Quick start

### 1. Requirements

- Node.js **20+**

### 2. Install from npm (recommended)

Package: **`@umg0/umg0`** on the public registry (binary `umg0`).

```bash
# smoke test
npx -y @umg0/umg0 retain --content "Remember: prefer TypeScript strict mode" --tier semantic
npx -y @umg0/umg0 recall --query "TypeScript"
npx -y @umg0/umg0 stats
```

**MCP config** (preferred — paste into Claude Code, Cursor, etc.):

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

**Global install** (faster cold start than npx):

```bash
npm install -g @umg0/umg0
```

```json
{
  "mcpServers": {
    "umg": {
      "command": "umg0",
      "args": ["mcp"]
    }
  }
}
```

### 3. From this repo (dev / offline / contribution)

```bash
git clone https://github.com/Hananahsan/umg.git
cd umg
npm install
npm run build
npm install -g .          # exposes umg0 on PATH
# or run directly:
node dist/index.js mcp
```

**From-source MCP** (absolute path — many hosts do not expand `~`):

```json
{
  "mcpServers": {
    "umg": {
      "command": "node",
      "args": ["/absolute/path/to/umg/dist/index.js", "mcp"]
    }
  }
}
```

Dev without building:

```bash
npx tsx src/index.ts retain --content "..." --tier semantic
```

Client samples: [examples/claude-code.mcp.json](./examples/claude-code.mcp.json) · [examples/cursor.mcp.json](./examples/cursor.mcp.json) · [examples/hermes.config.snippet.yaml](./examples/hermes.config.snippet.yaml) · [examples/vscode-cline.mcp.json](./examples/vscode-cline.mcp.json)

Restart the client after saving config.

**Single-writer:** one MCP process per DB file. Point every client at the **same** server command/DB — do not run multiple writers against one SQLite file.

### 4. Optional: database path

Default if unset: `~/.umg/memory.db` (resolved by config). Only set `UMG_DB_PATH` if you need a custom location — use an **absolute** path (many MCP hosts do not expand `~`).

```bash
export UMG_DB_PATH="$HOME/.umg/memory.db"
```

## Agent usage pattern

At **session start:** `recall` with project + task (+ entity names).  
When you learn something durable: `retain` (tier `semantic` for prefs/decisions).  
At **session end:** `reflect` with short labeled bullets.  
Periodically: `prune` (`dry_run: true` first).

| Resource | Use |
|----------|-----|
| [examples/session-start.md](./examples/session-start.md) | Session-open playbook |
| [examples/session-end.md](./examples/session-end.md) | Session-close checklist |
| [examples/coding-agent-prompt.md](./examples/coding-agent-prompt.md) | Coding agent system prompt |
| [examples/agent-system-prompt.md](./examples/agent-system-prompt.md) | General agent prompt |
| [examples/workflows/daily-coding.md](./examples/workflows/daily-coding.md) | Full-day tool sequences |
| [examples/claude-code-hooks.md](./examples/claude-code-hooks.md) | Optional Claude Code Stop hook |

## Memory hierarchy

| Tier | Purpose | Default pressure |
|------|---------|------------------|
| `working` | Current task scratch | 24h TTL, cap 50 |
| `episodic` | Specific interactions | 30d TTL, cap 500 |
| `semantic` | Facts, prefs, decisions | 365d, cap 1000 |
| `procedural` | Skills / lessons | near-immortal, cap 200 |

## Configuration

Copy [config.example.yaml](./config.example.yaml) to `~/.umg/config.yaml` or `./umg.config.yaml`.

| Env | Meaning |
|-----|---------|
| `UMG_DB_PATH` | SQLite file path |
| `UMG_NAMESPACE` | Default namespace |
| `UMG_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `UMG_LLM_ENABLED` | `true` enables optional LLM reflect |
| `UMG_EMBEDDINGS_ENABLED` | `true` enables optional hybrid embeddings |
| `UMG_HARD_ISOLATION` | `true` forces default namespace on recall |

## CLI

```bash
umg0 mcp
umg0 retain --content "..." [--tier semantic] [--namespace global]
umg0 recall --query "..." [--limit 8]
umg0 list [--tier semantic] [--namespace global] [--tags a,b] [--limit 20] [--offset 0] [--status active]
umg0 reflect --text "..."
umg0 promote --ids id1,id2 [--dry-run]
umg0 prune [--dry-run] [--aggressive] [--namespace ns]
umg0 stats
umg0 compact [--export-archives]
umg0 version
umg0 help
```

Also: `npx -y @umg0/umg0 <command>` and `node dist/index.js <command>`.

## Tests

```bash
npm test
npm run e2e
```

## Marketing site (umg0)

```bash
cd site && npm install && npm run dev
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Out of scope (current)

Multi-backend routing (Mem0/Zep), multi-tenant cloud, UI dashboard, graph DB, remote/HTTP MCP transport, attestation/federation.

## License

MIT
