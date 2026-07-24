# umg — Unified Memory Gateway

MCP-first, local-first hierarchical memory for AI agents.  
Think **“OpenRouter for agent memory”** — hierarchical local memory with **gateway architecture ready**.

Marketing site: **Nura**. Technical package name remains **UMG**.

**Problem it solves:** agent amnesia and re-explanation tax, without unbounded memory bloat.

**v0.2 positioning:** multi-backend routing is **out of scope**. One excellent local store + clean `MemoryStore` port.

## Features (v0.2)

- **MCP tools:** `retain`, `recall`, `reflect`, `list_memories`, `prune`, `promote_to_skill` (+ `dry_run`)
- **Hierarchy:** working → episodic → semantic → procedural
- **Configurable ranking weights** (FTS, importance, decay, tier, recency, entity)
- **Smarter importance:** entity density + rarity (namespace-aware)
- **Decay:** tunable α/β, session-recency boost, tier-aware access saturation
- **Additive-first writes** with confidence-gated supersede (≥0.75) + entity alias normalization
- **Multi-pass merge** + promotion quality gates + proposed skills dry-run
- **Local SQLite** WAL + busy_timeout; `umg compact`; size soft-warn
- **7-day metrics** in `umg stats` / `umg://stats`
- **Optional hybrid embeddings** (off by default; FTS remains primary offline path)
- **Optional hard namespace isolation**

## Quick start (< 5 minutes)

### Requirements

- Node.js 20+

### Install & build

```bash
cd ~/umg
npm install
npm run build
```

### Smoke test via CLI

```bash
# Store a fact
npx tsx src/index.ts retain --content "Remember: prefer TypeScript strict mode" --tier semantic

# Recall it
npx tsx src/index.ts recall --query "TypeScript"

# Stats
npx tsx src/index.ts stats

# Dry-run prune
npx tsx src/index.ts prune --dry-run

# Stats (weights + 7d metrics + size)
npx tsx src/index.ts stats

# Compact DB (VACUUM)
npx tsx src/index.ts compact
```

### One-liner Claude Code MCP

```json
{ "mcpServers": { "umg": { "command": "node", "args": ["/Users/hananahsan/umg/dist/index.js", "mcp"] } } }
```

**Single-writer:** one MCP process per DB file. Point all clients at the same server config — do not open multiple writers on one SQLite file.

### Connect to Claude Code

Add to `~/.claude.json` (user scope) or project `.mcp.json`:

```json
{
  "mcpServers": {
    "umg": {
      "command": "node",
      "args": ["/Users/hananahsan/umg/dist/index.js", "mcp"],
      "env": {
        "UMG_DB_PATH": "/Users/YOUR_USER/.umg/memory.db"
      }
    }
  }
}
```

Or with `tsx` during development:

```json
{
  "mcpServers": {
    "umg": {
      "command": "npx",
      "args": ["tsx", "/Users/hananahsan/umg/src/index.ts", "mcp"]
    }
  }
}
```

### Connect to Cursor

Create or edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "umg": {
      "command": "node",
      "args": ["/Users/hananahsan/umg/dist/index.js", "mcp"]
    }
  }
}
```

### Agent usage pattern

At session start:

> Call `recall` with the project name and current task.  
> Or use MCP prompt `session-start`.

When you learn something durable:

> Call `retain` with a concise fact (tier semantic if it’s a preference/decision).  
> Corrections supersede contradictory priors automatically when detected.

At session end:

> Call `reflect` with a short dump of decisions and preferences from this session.  
> Or use MCP prompt `session-end`.  
> Optional Claude Code Stop hook: [examples/claude-code-hooks.md](./examples/claude-code-hooks.md).

Periodically:

> Call `prune` (optionally `dry_run: true` first).  
> On MCP/CLI start, UMG also runs a light prune if the last prune was >24h ago.

See [examples/agent-system-prompt.md](./examples/agent-system-prompt.md).

## Memory hierarchy

| Tier | Purpose | Default pressure |
|------|---------|------------------|
| `working` | Current task scratch | 24h TTL, cap 50 |
| `episodic` | Specific interactions | 30d TTL, cap 500 |
| `semantic` | Facts, prefs, decisions | 365d, cap 1000 |
| `procedural` | Skills / lessons | near-immortal, cap 200 |

## Configuration

Copy `config.example.yaml` to `~/.umg/config.yaml` or `./umg.config.yaml`.

Key env vars:

| Env | Meaning |
|-----|---------|
| `UMG_DB_PATH` | SQLite file path |
| `UMG_NAMESPACE` | Default namespace |
| `UMG_LOG_LEVEL` | `debug\|info\|warn\|error` |
| `UMG_LLM_ENABLED` | `true` enables LLM reflect |
| `UMG_LLM_API_KEY` | API key for LLM reflect |
| `UMG_LLM_BASE_URL` | OpenAI-compatible base URL |
| `UMG_LLM_MODEL` | Model name |

## CLI

```bash
umg mcp
umg retain --content "..." [--tier semantic] [--namespace global]
umg recall --query "..." [--limit 8]
umg reflect --text "..."
umg prune [--dry-run] [--aggressive] [--namespace ns]
umg stats
umg help
```

## Tests

```bash
npm test
npm run e2e
```

## Marketing site (Nura)

Product landing page lives in [`site/`](./site/) (Astro + Tailwind). Brand name: **Nura**.

```bash
cd site && npm install && npm run dev
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for layers, data model, pruning math, and explicit trade-offs.

## Out of scope (v1)

Multi-backend routing (Mem0/Zep), multi-tenant cloud, UI dashboard, graph DB, attestation/federation.

## License

MIT
