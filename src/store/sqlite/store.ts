import Database from "better-sqlite3";
import { statSync } from "node:fs";
import type { MemoryStore } from "../interface.js";
import type {
  CountFilter,
  ListFilter,
  Memory,
  MemoryEvent,
  MemoryStatus,
  MemoryTier,
  ScoredMemory,
  SearchQuery,
  SimilarOpts,
  StatsSnapshot,
} from "../../types.js";
import { MEMORY_TIERS } from "../../types.js";
import { migrate } from "./migrations.js";
import { FTS_PROBE_SQL } from "./schema.js";
import { contentHash, jaccard, normalizeText, toFtsQuery, tokenize } from "../../util/text.js";
import { log } from "../../util/log.js";
import { ensureDbDir, type UmgConfig } from "../../config.js";
import { computeMetrics7d } from "../../observability/metrics.js";

interface MemoryRow {
  id: string;
  tier: MemoryTier;
  status: MemoryStatus;
  content: string;
  summary: string | null;
  namespace: string;
  tags_json: string;
  entities_json: string;
  source: string | null;
  session_id: string | null;
  importance: number;
  confidence: number;
  access_count: number;
  last_accessed_at: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  decay_score: number;
  embedding_json: string | null;
  metadata_json: string;
  parent_ids_json: string;
  supersedes_id: string | null;
  content_norm: string;
  content_hash: string;
}

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObj(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    tier: row.tier,
    status: row.status,
    content: row.content,
    summary: row.summary,
    namespace: row.namespace,
    tags: parseJsonArray(row.tags_json),
    entities: parseJsonArray(row.entities_json),
    source: row.source,
    session_id: row.session_id,
    importance: row.importance,
    confidence: row.confidence,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    decay_score: row.decay_score,
    embedding: row.embedding_json ? (JSON.parse(row.embedding_json) as number[]) : null,
    metadata: parseJsonObj(row.metadata_json),
    parent_ids: parseJsonArray(row.parent_ids_json),
    supersedes_id: row.supersedes_id,
  };
}

export class SqliteMemoryStore implements MemoryStore {
  private db: Database.Database;
  private ftsAvailable = true;
  private dbPath: string;
  private cfg?: UmgConfig;

  constructor(dbPath: string, cfg?: UmgConfig) {
    this.dbPath = dbPath;
    this.cfg = cfg;
    if (dbPath !== ":memory:") {
      ensureDbDir(dbPath);
    }
    this.db = new Database(dbPath);
    // Single-writer local discipline: WAL + busy_timeout for multi-client safety
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    const busy = cfg?.sqlite.busy_timeout_ms ?? 5000;
    this.db.pragma(`busy_timeout = ${busy}`);
    migrate(this.db);
    try {
      this.db.prepare(FTS_PROBE_SQL).get();
    } catch (err) {
      this.ftsAvailable = false;
      // Loud on purpose: this drops BM25 ranking for every search and degrades
      // near-duplicate detection, so it must never pass as routine noise.
      log.error("FTS5 unavailable; falling back to LIKE + Jaccard (search quality degraded)", {
        error: String(err),
        db: this.dbPath,
      });
    }
  }

  /** Whether BM25 search is live. False means the degraded LIKE fallback is in use. */
  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  async put(memory: Memory): Promise<Memory> {
    const norm = normalizeText(memory.content);
    const hash = contentHash(memory.content);
    this.db
      .prepare(
        `INSERT INTO memories (
          id, tier, status, content, summary, namespace, tags_json, entities_json,
          source, session_id, importance, confidence, access_count, last_accessed_at,
          created_at, updated_at, expires_at, decay_score, embedding_json, metadata_json,
          parent_ids_json, supersedes_id, content_norm, content_hash
        ) VALUES (
          @id, @tier, @status, @content, @summary, @namespace, @tags_json, @entities_json,
          @source, @session_id, @importance, @confidence, @access_count, @last_accessed_at,
          @created_at, @updated_at, @expires_at, @decay_score, @embedding_json, @metadata_json,
          @parent_ids_json, @supersedes_id, @content_norm, @content_hash
        )`,
      )
      .run({
        id: memory.id,
        tier: memory.tier,
        status: memory.status,
        content: memory.content,
        summary: memory.summary ?? null,
        namespace: memory.namespace,
        tags_json: JSON.stringify(memory.tags ?? []),
        entities_json: JSON.stringify(memory.entities ?? []),
        source: memory.source ?? null,
        session_id: memory.session_id ?? null,
        importance: memory.importance,
        confidence: memory.confidence,
        access_count: memory.access_count,
        last_accessed_at: memory.last_accessed_at,
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        expires_at: memory.expires_at ?? null,
        decay_score: memory.decay_score,
        embedding_json: memory.embedding ? JSON.stringify(memory.embedding) : null,
        metadata_json: JSON.stringify(memory.metadata ?? {}),
        parent_ids_json: JSON.stringify(memory.parent_ids ?? []),
        supersedes_id: memory.supersedes_id ?? null,
        content_norm: norm,
        content_hash: hash,
      });
    return memory;
  }

  async get(id: string): Promise<Memory | null> {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    return row ? rowToMemory(row) : null;
  }

  async update(id: string, patch: Partial<Memory>): Promise<Memory> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);
    const merged: Memory = {
      ...existing,
      ...patch,
      id: existing.id,
      tags: patch.tags ?? existing.tags,
      entities: patch.entities ?? existing.entities,
      metadata: patch.metadata ?? existing.metadata,
      parent_ids: patch.parent_ids ?? existing.parent_ids,
      updated_at: patch.updated_at ?? new Date().toISOString(),
    };
    const norm = normalizeText(merged.content);
    const hash = contentHash(merged.content);
    this.db
      .prepare(
        `UPDATE memories SET
          tier=@tier, status=@status, content=@content, summary=@summary, namespace=@namespace,
          tags_json=@tags_json, entities_json=@entities_json, source=@source, session_id=@session_id,
          importance=@importance, confidence=@confidence, access_count=@access_count,
          last_accessed_at=@last_accessed_at, updated_at=@updated_at, expires_at=@expires_at,
          decay_score=@decay_score, embedding_json=@embedding_json, metadata_json=@metadata_json,
          parent_ids_json=@parent_ids_json, supersedes_id=@supersedes_id,
          content_norm=@content_norm, content_hash=@content_hash
        WHERE id=@id`,
      )
      .run({
        id: merged.id,
        tier: merged.tier,
        status: merged.status,
        content: merged.content,
        summary: merged.summary ?? null,
        namespace: merged.namespace,
        tags_json: JSON.stringify(merged.tags ?? []),
        entities_json: JSON.stringify(merged.entities ?? []),
        source: merged.source ?? null,
        session_id: merged.session_id ?? null,
        importance: merged.importance,
        confidence: merged.confidence,
        access_count: merged.access_count,
        last_accessed_at: merged.last_accessed_at,
        updated_at: merged.updated_at,
        expires_at: merged.expires_at ?? null,
        decay_score: merged.decay_score,
        embedding_json: merged.embedding ? JSON.stringify(merged.embedding) : null,
        metadata_json: JSON.stringify(merged.metadata ?? {}),
        parent_ids_json: JSON.stringify(merged.parent_ids ?? []),
        supersedes_id: merged.supersedes_id ?? null,
        content_norm: norm,
        content_hash: hash,
      });
    return merged;
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  async archive(id: string): Promise<void> {
    this.db
      .prepare(
        `UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(new Date().toISOString(), id);
  }

  async search(query: SearchQuery): Promise<ScoredMemory[]> {
    const limit = query.limit ?? 20;
    const status = query.status ?? "active";
    const tiers = query.tiers;
    const namespace = query.namespace;

    if (!query.text || !query.text.trim()) {
      const listed = await this.list({
        namespace,
        tiers,
        status,
        limit,
        order_by: "importance",
        order_dir: "desc",
      });
      return listed.map((m) => ({ ...m, score: m.importance * m.decay_score }));
    }

    if (this.ftsAvailable) {
      try {
        return this.searchFts(query, limit, status);
      } catch (err) {
        log.warn("FTS search failed; falling back to LIKE", { error: String(err) });
      }
    }
    return this.searchLike(query, limit, status);
  }

  private searchFts(query: SearchQuery, limit: number, status: MemoryStatus): ScoredMemory[] {
    const ftsQ = toFtsQuery(query.text!);
    const params: unknown[] = [ftsQ, status];
    let sql = `
      SELECT m.*, bm25(memories_fts) AS bm25_score
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.status = ?
    `;
    if (query.namespace) {
      sql += " AND m.namespace = ?";
      params.push(query.namespace);
    }
    if (query.tiers && query.tiers.length > 0) {
      sql += ` AND m.tier IN (${query.tiers.map(() => "?").join(",")})`;
      params.push(...query.tiers);
    }
    if (query.include_working === false) {
      sql += " AND m.tier != 'working'";
    }
    sql += " ORDER BY bm25_score ASC LIMIT ?";
    params.push(limit * 3); // over-fetch for re-rank

    const rows = this.db.prepare(sql).all(...params) as Array<MemoryRow & { bm25_score: number }>;
    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.bm25_score)), 1e-6);

    let results: ScoredMemory[] = rows.map((r) => {
      const mem = rowToMemory(r);
      // SQLite bm25() returns negatives where a *more* negative value is a better
      // match, so |bm25| is already higher-is-better. Scale it to [0,1] against the
      // best hit in this result set. `rankForRecall` treats this value as
      // interchangeable with `jaccard`, which is higher-is-better, so the
      // orientation has to match or the whole ranking flips.
      const fts = Math.min(1, Math.abs(r.bm25_score) / maxAbs);
      const score = fts;
      return { ...mem, score, score_breakdown: { fts } };
    });

    if (query.tags && query.tags.length > 0) {
      const want = new Set(query.tags.map((t) => t.toLowerCase()));
      results = results.filter((m) => m.tags.some((t) => want.has(t.toLowerCase())));
    }

    return results.slice(0, limit);
  }

  private searchLike(query: SearchQuery, limit: number, status: MemoryStatus): ScoredMemory[] {
    const tokens = tokenize(query.text!);
    const params: unknown[] = [status];
    let sql = `SELECT * FROM memories WHERE status = ?`;
    if (query.namespace) {
      sql += " AND namespace = ?";
      params.push(query.namespace);
    }
    if (query.tiers && query.tiers.length > 0) {
      sql += ` AND tier IN (${query.tiers.map(() => "?").join(",")})`;
      params.push(...query.tiers);
    }
    if (query.include_working === false) {
      sql += " AND tier != 'working'";
    }
    // Soft filter: any token match
    if (tokens.length > 0) {
      const likes = tokens.map(() => `(content LIKE ? OR summary LIKE ?)`).join(" OR ");
      sql += ` AND (${likes})`;
      for (const t of tokens) {
        params.push(`%${t}%`, `%${t}%`);
      }
    }
    sql += " ORDER BY importance DESC LIMIT ?";
    params.push(limit * 3);

    const rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    const results = rows.map((r) => {
      const mem = rowToMemory(r);
      const jac = jaccard(query.text!, mem.content);
      return { ...mem, score: jac, score_breakdown: { jaccard: jac } };
    });
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async list(filter: ListFilter): Promise<Memory[]> {
    const status = filter.status ?? "active";
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;
    const orderBy = filter.order_by ?? "updated_at";
    const orderDir = filter.order_dir ?? "desc";
    const allowed = new Set([
      "created_at",
      "updated_at",
      "importance",
      "decay_score",
      "last_accessed_at",
    ]);
    const col = allowed.has(orderBy) ? orderBy : "updated_at";
    const dir = orderDir === "asc" ? "ASC" : "DESC";

    const params: unknown[] = [status];
    let sql = `SELECT * FROM memories WHERE status = ?`;
    if (filter.namespace) {
      sql += " AND namespace = ?";
      params.push(filter.namespace);
    }
    if (filter.tiers && filter.tiers.length > 0) {
      sql += ` AND tier IN (${filter.tiers.map(() => "?").join(",")})`;
      params.push(...filter.tiers);
    }
    if (filter.session_id) {
      sql += " AND session_id = ?";
      params.push(filter.session_id);
    }
    sql += ` ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    let rows = this.db.prepare(sql).all(...params) as MemoryRow[];
    let memories = rows.map(rowToMemory);
    if (filter.tags && filter.tags.length > 0) {
      const want = new Set(filter.tags.map((t) => t.toLowerCase()));
      memories = memories.filter((m) => m.tags.some((t) => want.has(t.toLowerCase())));
    }
    return memories;
  }

  async count(filter: CountFilter): Promise<number> {
    const status = filter.status ?? "active";
    const params: unknown[] = [status];
    let sql = `SELECT COUNT(*) AS c FROM memories WHERE status = ?`;
    if (filter.namespace) {
      sql += " AND namespace = ?";
      params.push(filter.namespace);
    }
    if (filter.tier) {
      sql += " AND tier = ?";
      params.push(filter.tier);
    }
    const row = this.db.prepare(sql).get(...params) as { c: number };
    return row.c;
  }

  async findSimilar(content: string, opts: SimilarOpts = {}): Promise<ScoredMemory[]> {
    const limit = opts.limit ?? 10;
    const hash = contentHash(content);

    // Exact hash match first
    const exactParams: unknown[] = [hash, "active"];
    let exactSql = `SELECT * FROM memories WHERE content_hash = ? AND status = ?`;
    if (opts.namespace) {
      exactSql += " AND namespace = ?";
      exactParams.push(opts.namespace);
    }
    if (opts.exclude_id) {
      exactSql += " AND id != ?";
      exactParams.push(opts.exclude_id);
    }
    const exact = this.db.prepare(exactSql).all(...exactParams) as MemoryRow[];

    const scored: ScoredMemory[] = exact.map((r) => ({
      ...rowToMemory(r),
      score: 1,
      score_breakdown: { exact_hash: 1 },
    }));

    // FTS / LIKE candidates
    const candidates = await this.search({
      text: content,
      namespace: opts.namespace,
      tiers: opts.tiers,
      limit: limit * 2,
      status: "active",
    });

    for (const c of candidates) {
      if (opts.exclude_id && c.id === opts.exclude_id) continue;
      if (scored.some((s) => s.id === c.id)) continue;
      const jac = jaccard(content, c.content);
      const entityBoost = entityOverlap(content, c);
      const score = Math.min(1, jac * 0.85 + entityBoost * 0.15);
      scored.push({
        ...c,
        score,
        score_breakdown: { jaccard: jac, entity: entityBoost },
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async logEvent(event: MemoryEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO events (id, ts, kind, memory_id, detail_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.ts,
        event.kind,
        event.memory_id ?? null,
        JSON.stringify(event.detail ?? {}),
      );
  }

  async listEvents(limit = 20): Promise<MemoryEvent[]> {
    const rows = this.db
      .prepare(`SELECT * FROM events ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Array<{
      id: string;
      ts: string;
      kind: string;
      memory_id: string | null;
      detail_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind as MemoryEvent["kind"],
      memory_id: r.memory_id,
      detail: parseJsonObj(r.detail_json),
    }));
  }

  async purgeOldEvents(maxEvents: number): Promise<number> {
    const count = this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number };
    if (count.c <= maxEvents) return 0;
    const toDelete = count.c - maxEvents;
    const res = this.db
      .prepare(
        `DELETE FROM events WHERE id IN (
          SELECT id FROM events ORDER BY ts ASC LIMIT ?
        )`,
      )
      .run(toDelete);
    return res.changes;
  }

  async purgeArchivedOlderThan(isoCutoff: string): Promise<number> {
    const res = this.db
      .prepare(
        `DELETE FROM memories WHERE status = 'archived' AND updated_at < ?`,
      )
      .run(isoCutoff);
    return res.changes;
  }

  async stats(defaultNamespace: string): Promise<StatsSnapshot> {
    const active_by_tier = {} as Record<MemoryTier, number>;
    for (const t of MEMORY_TIERS) {
      active_by_tier[t] = await this.count({ tier: t, status: "active" });
    }
    const archived = await this.count({ status: "archived" });
    const total_active = Object.values(active_by_tier).reduce((a, b) => a + b, 0);
    const avgs = this.db
      .prepare(
        `SELECT AVG(decay_score) AS ad, AVG(importance) AS ai FROM memories WHERE status = 'active'`,
      )
      .get() as { ad: number | null; ai: number | null };
    const events = await this.listEvents(10);
    const db_size_bytes = this.dbFileSizeBytes();
    const warnAt = this.cfg?.sqlite.size_warn_bytes ?? 52_428_800;
    const windowDays = this.cfg?.observability.metrics_window_days ?? 7;
    const metrics_7d = await computeMetrics7d(this, windowDays);
    return {
      active_by_tier,
      archived,
      total_active,
      avg_decay: avgs.ad ?? 0,
      avg_importance: avgs.ai ?? 0,
      recent_events: events.map((e) => ({
        kind: e.kind,
        ts: e.ts,
        detail: e.detail,
      })),
      db_path: this.db.name,
      namespace_default: defaultNamespace,
      ranking_weights: this.cfg?.recall.ranking_weights,
      db_size_bytes,
      db_size_warn: db_size_bytes >= warnAt,
      fts_available: this.ftsAvailable,
      metrics_7d,
    };
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  async entityFrequency(
    namespace: string,
    limit = 2000,
  ): Promise<Map<string, number>> {
    const rows = this.db
      .prepare(
        `SELECT entities_json FROM memories WHERE status = 'active' AND namespace = ? LIMIT ?`,
      )
      .all(namespace, limit) as Array<{ entities_json: string }>;
    const freq = new Map<string, number>();
    for (const r of rows) {
      const ents = parseJsonArray(r.entities_json);
      const seen = new Set<string>();
      for (const e of ents) {
        const k = e.toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        freq.set(k, (freq.get(k) ?? 0) + 1);
      }
    }
    return freq;
  }

  dbFileSizeBytes(): number {
    if (this.dbPath === ":memory:") return 0;
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  async listArchived(limit = 5000): Promise<Memory[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE status = 'archived' ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  close(): void {
    this.db.close();
  }
}

function entityOverlap(content: string, mem: Memory): number {
  if (!mem.entities.length) return 0;
  const lower = content.toLowerCase();
  let hits = 0;
  for (const e of mem.entities) {
    if (e && lower.includes(e.toLowerCase())) hits++;
  }
  return hits / mem.entities.length;
}
