# umg — Unified Memory Gateway

MCP-first, local-first hierarchical memory for AI agents.  
Think **“OpenRouter for agent memory”** — hierarchical local memory with **gateway architecture ready**.

Works with **Claude Code, Cursor, Hermes, Cline, Roo Code, VS Code + GitHub Copilot, Zed, Windsurf, ChatGPT (Developer Mode), and any MCP-compatible client.** Same stdio MCP server; only the config file location changes.

Marketing site: **[Nura](./site/)** · Technical package: **UMG**

**Problem it solves:** agent amnesia and the re-explanation tax, without unbounded memory bloat.

**v0.2 positioning:** multi-backend routing is **out of scope**. One excellent local store + clean `MemoryStore` port. Transport is **stdio MCP** today (remote/HTTP is future work).

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

See [examples/README.md](./examples/README.md) for a full map.

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

### 2. Install & build

```bash
git clone https://github.com/Hananahsan/umg.git
cd umg
npm install
npm run build
```

The primary path is **clone + build** (not yet assumed published on npm). After build, the MCP entrypoint is `dist/index.js`.

### 3. Optional: database path

```bash
export UMG_DB_PATH="$HOME/.umg/memory.db"
```

Default if unset: `~/.umg/memory.db` (from config defaults).

### 4. Connect your MCP client

Replace `/absolute/path/to/umg` with your clone path.

**Generic MCP block** (same shape for most hosts):

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

**Claude Code** — merge into `~/.claude.json` or project `.mcp.json`  
→ full sample: [examples/claude-code.mcp.json](./examples/claude-code.mcp.json)

**Cursor** — `~/.cursor/mcp.json`  
→ [examples/cursor.mcp.json](./examples/cursor.mcp.json)

**Hermes** — YAML `mcp_servers` style  
→ [examples/hermes.config.snippet.yaml](./examples/hermes.config.snippet.yaml)

**VS Code / Cline / Roo** — generic JSON  
→ [examples/vscode-cline.mcp.json](./examples/vscode-cline.mcp.json)

Restart the client after saving config.

**Single-writer:** one MCP process per DB file. Point every client at the **same** server command/DB — do not run multiple writers against one SQLite file.

### 5. Smoke test (CLI)

```bash
cd /absolute/path/to/umg

node dist/index.js retain --content "Remember: prefer TypeScript strict mode" --tier semantic
node dist/index.js recall --query "TypeScript"
node dist/index.js stats
node dist/index.js prune --dry-run
```

Dev without building:

```bash
npx tsx src/index.ts retain --content "..." --tier semantic
```

## Agent usage pattern

At **session start:** `recall` with project + task (+ entity names).  
When you learn something durable: `retain` (tier `semantic` for prefs/decisions).  
At **session end:** `reflect` with short bullets.  
Periodically: `prune` (`dry_run: true` first).

Recommended prompt: [examples/agent-system-prompt.md](./examples/agent-system-prompt.md)  
Optional Claude Code Stop hook: [examples/claude-code-hooks.md](./examples/claude-code-hooks.md)

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
umg mcp
umg retain --content "..." [--tier semantic] [--namespace global]
umg recall --query "..." [--limit 8]
umg reflect --text "..."
umg promote --ids id1,id2 [--dry-run]
umg prune [--dry-run] [--aggressive] [--namespace ns]
umg stats
umg compact [--export-archives]
umg help
```

## Tests

```bash
npm test
npm run e2e
```

## Marketing site (Nura)

```bash
cd site && npm install && npm run dev
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Out of scope (current)

Multi-backend routing (Mem0/Zep), multi-tenant cloud, UI dashboard, graph DB, remote/HTTP MCP transport, attestation/federation.

## License

MIT
