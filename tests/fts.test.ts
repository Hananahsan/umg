import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteMemoryStore } from "../src/store/sqlite/store.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/store/sqlite/schema.js";
import { defaultConfig } from "../src/config.js";
import { log } from "../src/util/log.js";
import type { Memory } from "../src/types.js";

/**
 * FTS5 must actually be live. It silently degraded to the LIKE fallback for every
 * install because the external-content FTS table declared `tags`/`entities` while
 * `memories` has `tags_json`/`entities_json` — external-content mode resolves values
 * by selecting identically-named columns from the content table.
 */

function makeMemory(over: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: over.id ?? `m-${Math.random().toString(36).slice(2, 10)}`,
    tier: "semantic",
    status: "active",
    content: "placeholder content",
    summary: null,
    namespace: "test",
    tags: [],
    entities: [],
    source: null,
    session_id: null,
    importance: 0.8,
    confidence: 0.8,
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    expires_at: null,
    decay_score: 1,
    embedding: null,
    metadata: {},
    parent_ids: [],
    supersedes_id: null,
    ...over,
  } as Memory;
}

/** The pre-fix (schema_version 1) FTS definition, as it exists in databases in the wild. */
const BROKEN_FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, summary, tags, entities, content='memories', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, summary, tags, entities)
  VALUES (new.rowid, new.content, coalesce(new.summary, ''), new.tags_json, new.entities_json);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags, entities)
  VALUES ('delete', old.rowid, old.content, coalesce(old.summary, ''), old.tags_json, old.entities_json);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, summary, tags, entities)
  VALUES ('delete', old.rowid, old.content, coalesce(old.summary, ''), old.tags_json, old.entities_json);
  INSERT INTO memories_fts(rowid, content, summary, tags, entities)
  VALUES (new.rowid, new.content, coalesce(new.summary, ''), new.tags_json, new.entities_json);
END;
`;

describe("sqlite FTS5", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteMemoryStore | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-fts-"));
    dbPath = join(dir, "test.db");
    store = undefined;
  });

  afterEach(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function open(): SqliteMemoryStore {
    const cfg = defaultConfig();
    cfg.db_path = dbPath;
    cfg.log_level = "error";
    store = new SqliteMemoryStore(dbPath, cfg);
    return store;
  }

  it("is available on a freshly migrated database", () => {
    expect(open().isFtsAvailable()).toBe(true);
  });

  it("is available on an in-memory database", () => {
    const s = new SqliteMemoryStore(":memory:");
    try {
      expect(s.isFtsAvailable()).toBe(true);
    } finally {
      s.close();
    }
  });

  it("ranks search results with BM25 rather than the Jaccard fallback", async () => {
    const s = open();
    await s.put(
      makeMemory({
        content: "Postgres connection pooling is handled by pgbouncer in production.",
        tags: ["database"],
      }),
    );
    await s.put(
      makeMemory({ content: "The frontend uses Tailwind for styling.", tags: ["ui"] }),
    );

    const results = await s.search({ text: "pgbouncer pooling", namespace: "test" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toMatch(/pgbouncer/i);
    // BM25 path reports `fts`; the LIKE fallback reports `jaccard`.
    expect(results[0].score_breakdown).toHaveProperty("fts");
    expect(results[0].score_breakdown).not.toHaveProperty("jaccard");
  });

  it("indexes tags and entities so they are searchable", async () => {
    const s = open();
    await s.put(
      makeMemory({
        content: "Nightly export job writes to the warehouse.",
        tags: ["billing"],
        entities: ["Stripe"],
      }),
    );

    expect((await s.search({ text: "billing", namespace: "test" })).length).toBeGreaterThan(0);
    expect((await s.search({ text: "Stripe", namespace: "test" })).length).toBeGreaterThan(0);
  });

  it("scores stronger BM25 matches higher than weaker ones", async () => {
    const s = open();
    await s.put(
      makeMemory({
        id: "strong",
        content: "pgbouncer pgbouncer pgbouncer pooling pooling connection pooling",
      }),
    );
    await s.put(makeMemory({ id: "medium", content: "pgbouncer handles pooling for one service" }));
    await s.put(
      makeMemory({
        id: "weak",
        content:
          "pooling is mentioned once here among many other unrelated words about deployment and CI",
      }),
    );

    const results = await s.search({ text: "pgbouncer pooling", namespace: "test" });
    const byId = new Map(results.map((r) => [r.id, r.score_breakdown!.fts!]));

    // `rankForRecall` substitutes `jaccard` (higher = more similar) wherever `fts`
    // is absent, so `fts` must be higher-is-better too. SQLite bm25() is the
    // opposite sign, and forgetting that inverts the whole ranking.
    expect(byId.get("strong")!).toBeGreaterThan(byId.get("medium")!);
    expect(byId.get("medium")!).toBeGreaterThan(byId.get("weak")!);
    expect(results[0].id).toBe("strong");
  });

  it("gives a lone match a non-zero fts score", async () => {
    const s = open();
    await s.put(makeMemory({ content: "Only this row mentions pgbouncer at all." }));
    const results = await s.search({ text: "pgbouncer", namespace: "test" });
    expect(results).toHaveLength(1);
    expect(results[0].score_breakdown!.fts).toBeGreaterThan(0);
  });

  it("supports the external-content rebuild command", () => {
    const s = open();
    const db = (s as unknown as { db: Database.Database }).db;
    expect(() => db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")).not.toThrow();
  });

  it("keeps the index in sync on update and delete", async () => {
    const s = open();
    const m = await s.put(makeMemory({ content: "Deploys run through the legacy Jenkins box." }));

    expect((await s.search({ text: "Jenkins", namespace: "test" })).length).toBe(1);

    await s.update(m.id, { content: "Deploys run through GitHub Actions now." });
    expect((await s.search({ text: "Jenkins", namespace: "test" })).length).toBe(0);
    expect((await s.search({ text: "Actions", namespace: "test" })).length).toBe(1);

    await s.deleteUnaudited(m.id);
    expect((await s.search({ text: "Actions", namespace: "test" })).length).toBe(0);
  });

  it("reports loudly and still serves search when FTS is genuinely unusable", async () => {
    // Stamp the DB at the current version with a broken FTS table so the migration
    // does not re-run — this is the only way the fallback should ever be reached.
    const seed = new Database(dbPath);
    seed.exec(SCHEMA_SQL);
    seed.exec(
      `CREATE VIRTUAL TABLE memories_fts USING fts5(content, summary, tags, entities,
         content='memories', content_rowid='rowid');`,
    );
    seed
      .prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
    seed.close();

    const errors: string[] = [];
    const spy = vi.spyOn(log, "error").mockImplementation((msg) => {
      errors.push(msg);
    });
    try {
      const s = open();
      expect(s.isFtsAvailable()).toBe(false);
      // Degradation must be reported at error level, never silently.
      expect(errors.some((m) => /FTS5 unavailable/i.test(m))).toBe(true);

      // ...and the store must keep working on the LIKE fallback.
      await s.put(makeMemory({ content: "Fallback still finds kubernetes deploys." }));
      const r = await s.search({ text: "kubernetes", namespace: "test" });
      expect(r).toHaveLength(1);
      expect(r[0].score_breakdown).toHaveProperty("jaccard");
    } finally {
      spy.mockRestore();
    }
  });

  it("repairs a populated v1 database without losing rows", async () => {
    // The empty-database repair proves the mechanism; this proves it holds once
    // somebody actually has memories in there. 400 rows across all four tiers.
    const TIERS = ["working", "episodic", "semantic", "procedural"] as const;
    const COUNT = 400;

    const seed = new Database(dbPath);
    seed.exec(SCHEMA_SQL);
    seed.exec(BROKEN_FTS_SQL);
    seed
      .prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', '1') " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run();

    const now = new Date().toISOString();
    const insert = seed.prepare(
      `INSERT INTO memories (id, tier, status, content, summary, namespace, tags_json,
         entities_json, importance, confidence, access_count, last_accessed_at,
         created_at, updated_at, decay_score, metadata_json, parent_ids_json,
         content_norm, content_hash)
       VALUES (@id, @tier, 'active', @content, NULL, 'test', @tags, @entities,
         0.8, 0.8, 0, @now, @now, @now, 1.0, '{}', '[]', '', @hash)`,
    );
    seed.transaction(() => {
      for (let i = 0; i < COUNT; i++) {
        insert.run({
          id: `legacy-${i}`,
          tier: TIERS[i % TIERS.length],
          content: `Legacy memory zulu${i} describing a deployment decision`,
          tags: JSON.stringify([`tagbucket${i % 7}`]),
          entities: JSON.stringify([`Entityname${i}`]),
          now,
          hash: `h${i}`,
        });
      }
    })();
    expect(seed.prepare("SELECT count(*) c FROM memories").get()).toEqual({ c: COUNT });
    seed.close();

    // Migrate.
    const s = open();
    expect(s.isFtsAvailable()).toBe(true);

    // No rows lost, and the rebuilt index actually covers all of them. Note that
    // a plain count(*) on an external-content table reads `memories`, not the
    // index, so it would pass against a completely empty index — the MATCH count
    // is what proves the rebuild populated it.
    const db = (s as unknown as { db: Database.Database }).db;
    expect(db.prepare("SELECT count(*) c FROM memories").get()).toEqual({ c: COUNT });
    expect(
      db
        .prepare("SELECT count(*) c FROM memories_fts WHERE memories_fts MATCH 'deployment'")
        .get(),
    ).toEqual({ c: COUNT });

    // Every pre-existing row is findable by its own token, in every tier.
    const missing: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      const hits = await s.search({ text: `zulu${i}`, namespace: "test", limit: 5 });
      if (!hits.some((h) => h.id === `legacy-${i}`)) missing.push(`legacy-${i}`);
    }
    expect(missing).toEqual([]);

    // Tags and entities survived the rebuild and are still searchable.
    const byTag = await s.search({ text: "tagbucket3", namespace: "test", limit: 100 });
    expect(byTag.length).toBeGreaterThan(0);
    expect(byTag.every((m) => m.tags.includes("tagbucket3"))).toBe(true);

    const byEntity = await s.search({ text: "Entityname42", namespace: "test", limit: 5 });
    expect(byEntity.map((m) => m.id)).toContain("legacy-42");

    // Tier coverage is intact.
    for (const tier of TIERS) {
      const rows = await s.list({ namespace: "test", tiers: [tier], limit: 500 });
      expect(rows.length).toBe(COUNT / TIERS.length);
    }
  });

  it("repairs a schema_version 1 database that has the broken FTS table", async () => {
    // Build a v1 database exactly as shipped before the fix.
    const seed = new Database(dbPath);
    seed.exec(SCHEMA_SQL);
    seed.exec(BROKEN_FTS_SQL);
    seed
      .prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', '1') " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run();
    const now = new Date().toISOString();
    seed
      .prepare(
        `INSERT INTO memories (id, tier, status, content, summary, namespace, tags_json,
           entities_json, importance, confidence, access_count, last_accessed_at,
           created_at, updated_at, decay_score, metadata_json, parent_ids_json,
           content_norm, content_hash)
         VALUES ('legacy-1','semantic','active',
           'Legacy row written before the FTS fix mentions kubernetes.', NULL, 'test',
           '["infra"]', '["Kubernetes"]', 0.8, 0.8, 0, ?, ?, ?, 1.0, '{}', '[]', '', 'h1')`,
      )
      .run(now, now, now);
    // Sanity: the broken table is genuinely unusable for external-content reads.
    expect(() => seed.prepare("SELECT 1 FROM memories_fts LIMIT 1").get()).toThrow(
      /no such column/i,
    );
    seed.close();

    // Reopening must migrate the FTS table and leave FTS live.
    const s = open();
    expect(s.isFtsAvailable()).toBe(true);

    // Pre-existing rows must still be findable through the rebuilt index.
    const results = await s.search({ text: "kubernetes", namespace: "test" });
    expect(results.map((r) => r.id)).toContain("legacy-1");
  });
});
