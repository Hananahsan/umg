# UMG Architecture

## Thesis

A useful agent memory layer is not a bigger store. It is a **disciplined write path** plus **hierarchical retention** plus **aggressive consolidation**. The differentiator is pruning quality.

## Layers

```
Agents ──MCP stdio──► Interface (tools/resources)
                           │
                           ▼
                      Service layer
                   (memory, consolidation,
                    promotion, reflect, scoring)
                           │
                           ▼
                   MemoryStore port
                           │
                           ▼
                 SqliteMemoryStore (v1)
```

### Client interface

UMG exposes **MCP over stdio**. Any MCP-compatible host can connect (Claude Code, Cursor, Hermes, Cline/Roo, VS Code + Copilot, Zed, Windsurf, ChatGPT Developer Mode where MCP is enabled, and others). The protocol surface is the contract; client lists in marketing are illustrative. **Remote/HTTP MCP transport is future work** and is not claimed in v0.2.

**Rules**

- MCP handlers never touch SQL.
- Services never import the MCP SDK.
- Only the SQLite adapter knows about SQLite.
- Future backends implement `MemoryStore` — **no multi-backend router in v0.2**.
- Process-agnostic store: a future local daemon can own one `SqliteMemoryStore` without changing tools.

## Data model

Each memory has:

- **tier:** working | episodic | semantic | procedural  
- **status:** active | archived | evicted  
- **importance** (0–1) at write time  
- **decay_score** (0–1) from time + access  
- **namespace** for soft isolation  
- **entities[] / tags[]** for lightweight resolution (not a graph DB)  
- **parent_ids** for merge/promote lineage  
- **embedding** optional when `embeddings.enabled` (hybrid path); FTS primary offline  

Search: SQLite **FTS5 BM25** (+ optional cosine hybrid). LIKE + Jaccard fallback.

### SQLite reliability

- `journal_mode=WAL`, `busy_timeout` (default 5000ms), `synchronous=NORMAL`
- **Single-writer discipline:** one process owns the DB. Multiple agents share one MCP stdio server.
- `umg compact` runs `VACUUM` (+ optional archive JSONL export)

### Ranking (v0.2 configurable)

```
score = w_fts·fts + w_imp·importance + w_decay·decay
      + w_tier·tier + w_recency·recency + w_entity·entity
```

Defaults: 0.32 / 0.18 / 0.18 / 0.08 / 0.08 / 0.16. Sum should be ~1.0 (warn if not).

Optional hybrid when embedding present:
`α·fts + β·cosine + (1-α-β)·other` (defaults α=0.55, β=0.25).

## Write path (`retain`)

1. Normalize / truncate content  
2. Auto-tier (unless explicit)  
3. Reject low-information / below min importance  
4. `findSimilar`:
   - contradiction on same topic → **supersede** (archive prior, `supersedes_id` lineage)
   - else similarity ≥ threshold → **merge**
5. Else insert with default TTL  
6. Every N writes: light prune (decay + expiry)  
7. On process start: light prune if `last_prune_at` missing or older than 24h

## Read path (`recall`)

1. FTS (or LIKE) candidate set  
2. Multi-factor re-rank (v0.1.2 — entity boost, Mem0-inspired, no embeddings):

```
score = 0.32·fts + 0.18·importance + 0.18·decay
      + 0.08·tier_prior + 0.08·recency + 0.16·entity
```

`entity` = fraction of query-extracted entities matched on `memory.entities[]`
(content substring fallback when entities empty).

3. Touch access_count / last_accessed_at  
4. Emit observability event  

## Four consolidation levers

### 1. Importance

```
importance = clamp(tier_prior + boosts − penalties)
```

Boosts: remember/prefer/decision language, corrections, entity-dense short facts.  
Agent-supplied importance is soft-blended (70/30).

### 2. Merge (+ additive-first contradiction policy)

On write and full prune: Jaccard + FTS candidates.

- **Merge** when similarity ≥ `merge_threshold` (default 0.82) and no contradiction.  
  Keep richer content, max importance, union tags/entities, lineage via `parent_ids`.
- **Supersede** only on **clear** related contradictions (`conflicting_values`, `boolean_flip`,
  or strong negation/correction with high topic overlap). Archive loser; set `supersedes_id`.
- **Defer (additive-first)** on ambiguous conflicts: insert the new memory, leave prior active,
  stamp `metadata.conflict_deferred`. Later multi-pass prune can merge or supersede when clear.
- Full prune runs **up to `merge_max_passes` (default 3)** merge/supersede passes until a pass
  makes no changes.

Prefer false-negative supersede (temporary dual facts) over destroying a still-valid prior.

### 3. Decay

```
time_factor   = 0.5 ** (age_days / half_life)
access_factor = 1 − exp(−access_count / 5)
decay_score  = importance * (0.65·time_factor + 0.35·access_factor)
```

Half-lives: working 0.5d, episodic 14d, semantic 120d, procedural 730d.  
Procedural floor: 0.4.

### 4. Eviction

On prune:

1. Hard `expires_at` (`reason: expired`)  
2. Score floor after grace period (`reason: score_floor`) — **never** procedural when `evict_procedural: false`  
3. Per-tier caps (`reason: cap_tier`) then global cap (`reason: cap_global`)  
4. Procedural over tier cap with flag false → `cap_skip_procedural` (skills protected, no archive)  
5. Archive (default), purge archives older than retention  

Victims: lowest `decay_score`, then oldest access.

## Promotion

- Explicit `promote_to_skill`  
- Optional auto-promote when entity/tag clusters accumulate enough recalls across sessions  

Creates `procedural` skill body with lineage; may archive episodic sources.

## Reflect / write-back

Agents lack a universal post-turn hook. Portable pattern:

1. Agent calls `reflect` with session notes  
2. Heuristic extract (labeled lines, bullets, signal sentences)  
3. Optional OpenAI-compatible LLM extract if enabled  
4. Auto-`retain` candidates  

Degrades: LLM failure → heuristics.

## Observability

`events` table logs retain/recall/merge/decay/evict/promote/reflect/prune.  
CLI `umg stats` and MCP resource `umg://stats`.  
All logs on **stderr** (stdio MCP purity).

## Explicit trade-offs

1. **Heuristics over LLM for core consolidation** — offline, testable, predictable.  
2. **FTS5 over vectors by default** — great for exact prefs/IDs; weaker paraphrase.  
3. **Archive over hard delete** — safer; delayed purge.  
4. **Tiny tool surface** — fits agent context; advanced ops on CLI.  
5. **Namespace string ≠ multi-tenant ACL** — local single-user first.  
6. **No graph DB** — entities are arrays; enough for v1 merge hints.

## Extensibility (later)

```ts
interface MemoryStore {
  put / get / update / delete / archive
  search / list / count / findSimilar
  transaction / logEvent / stats / close
}
```

A future Mem0 or Zep adapter implements this port. A gateway router can sit above it without changing MCP tools.

## Default caps (aggressive)

| Scope | Cap |
|-------|-----|
| working | 50 |
| episodic | 500 |
| semantic | 1000 |
| procedural | 200 |
| global active | 2000 |
