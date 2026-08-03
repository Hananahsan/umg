/** Schema version for migrations. */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('working','episodic','semantic','procedural')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','evicted')),
  content TEXT NOT NULL,
  summary TEXT,
  namespace TEXT NOT NULL DEFAULT 'global',
  tags_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  source TEXT,
  session_id TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.7,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  decay_score REAL NOT NULL DEFAULT 1.0,
  embedding_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  parent_ids_json TEXT NOT NULL DEFAULT '[]',
  supersedes_id TEXT,
  content_norm TEXT NOT NULL DEFAULT '',
  content_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_memories_tier_status ON memories(tier, status);
CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_decay ON memories(decay_score);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  memory_id TEXT,
  detail_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
`;

/**
 * FTS5 uses content-sync triggers so the row table stays source of truth.
 * We index the raw tags/entities JSON so their tokens are searchable.
 *
 * The column names MUST match `memories` exactly. In external-content mode
 * (content='memories') FTS5 resolves column values by selecting identically
 * named columns from the content table, so a column named `tags` here — where
 * `memories` has `tags_json` — makes every external-content read fail with
 * "no such column: T.tags". That includes table scans and 'rebuild'.
 */
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  summary,
  tags_json,
  entities_json,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, tags_json, entities_json)
  VALUES (
    new.rowid,
    new.content,
    coalesce(new.summary, ''),
    new.tags_json,
    new.entities_json
  );
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags_json, entities_json)
  VALUES (
    'delete',
    old.rowid,
    old.content,
    coalesce(old.summary, ''),
    old.tags_json,
    old.entities_json
  );
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags_json, entities_json)
  VALUES (
    'delete',
    old.rowid,
    old.content,
    coalesce(old.summary, ''),
    old.tags_json,
    old.entities_json
  );
  INSERT INTO memories_fts(rowid, content, summary, tags_json, entities_json)
  VALUES (
    new.rowid,
    new.content,
    coalesce(new.summary, ''),
    new.tags_json,
    new.entities_json
  );
END;
`;

/** Tear down the FTS table and its sync triggers so FTS_SQL can recreate them. */
export const FTS_DROP_SQL = `
DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;
DROP TABLE IF EXISTS memories_fts;
`;

/**
 * Cheap probe that exercises external-content column resolution. It fails on an
 * empty table too, so a fresh database still catches a column-name mismatch.
 */
export const FTS_PROBE_SQL = `SELECT 1 FROM memories_fts LIMIT 1`;
