/** Schema version for migrations. */
export const SCHEMA_VERSION = 1;

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
 * We store a denormalized tags/entities string for search.
 */
export const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  summary,
  tags,
  entities,
  content='memories',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, tags, entities)
  VALUES (
    new.rowid,
    new.content,
    coalesce(new.summary, ''),
    new.tags_json,
    new.entities_json
  );
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags, entities)
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
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags, entities)
  VALUES (
    'delete',
    old.rowid,
    old.content,
    coalesce(old.summary, ''),
    old.tags_json,
    old.entities_json
  );
  INSERT INTO memories_fts(rowid, content, summary, tags, entities)
  VALUES (
    new.rowid,
    new.content,
    coalesce(new.summary, ''),
    new.tags_json,
    new.entities_json
  );
END;
`;
