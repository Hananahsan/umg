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

**Rules**

- MCP handlers never touch SQL.
- Services never import the MCP SDK.
- Only the SQLite adapter knows about SQLite.
- Future backends implement `MemoryStore` — no router in v1.

## Data model

Each memory has:

- **tier:** working | episodic | semantic | procedural  
- **status:** active | archived | evicted  
- **importance** (0–1) at write time  
- **decay_score** (0–1) from time + access  
- **namespace** for soft isolation  
- **entities[] / tags[]** for lightweight resolution (not a graph DB)  
- **parent_ids** for merge/promote lineage  
- **embedding** column reserved; unused in v1 retrieval  

Search: SQLite **FTS5 BM25**, with LIKE + Jaccard fallback.

## Write path (`retain`)

1. Normalize / truncate content  
2. Auto-tier (unless explicit)  
3. Reject low-information / below min importance  
4. `findSimilar` → merge if score ≥ threshold  
5. Else insert with default TTL  
6. Every N writes: light prune (decay + expiry)

## Read path (`recall`)

1. FTS (or LIKE) candidate set  
2. Multi-factor re-rank:

```
score = 0.40·fts + 0.20·importance + 0.20·decay + 0.10·tier_prior + 0.10·recency
```

3. Touch access_count / last_accessed_at  
4. Emit observability event  

## Four consolidation levers

### 1. Importance

```
importance = clamp(tier_prior + boosts − penalties)
```

Boosts: remember/prefer/decision language, corrections, entity-dense short facts.  
Agent-supplied importance is soft-blended (70/30).

### 2. Merge

On write and full prune: Jaccard + FTS candidates; merge ≥ `merge_threshold` (default 0.82).  
Keep richer content, max importance, union tags/entities, lineage via `parent_ids`.

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

1. Hard `expires_at`  
2. Score floor after grace period  
3. Per-tier caps then global cap  
4. Archive (default), purge archives older than retention  

Victims: lowest `decay_score`, then oldest access. Procedural protected unless configured.

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
