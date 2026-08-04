import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig, type UmgConfig } from "../src/config.js";
import { buildOverview } from "../src/inspector/api.js";
import { ReadOnlyStore, ReadOnlyViolationError } from "../src/store/readonly.js";

/**
 * The inspector's core promise. `prune({ dry_run: true })` emits events and
 * writes meta unconditionally, and auto-promote does the same on its dry-run
 * path — so "dry run" alone is not read-only. These tests assert the store
 * layer absorbs all of it and the file on disk never changes.
 */
describe("inspector read-only guarantee", () => {
  let dir: string;
  let dbPath: string;
  let cfg: UmgConfig;
  let before: { hash: string; memories: number; events: number };

  const snapshot = (): { hash: string; memories: number; events: number } => {
    const db = new Database(dbPath, { readonly: true });
    const memories = (db.prepare("SELECT COUNT(*) c FROM memories").get() as { c: number }).c;
    const events = (db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
    db.close();
    return {
      hash: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
      memories,
      events,
    };
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "umg-inspect-ro-"));
    dbPath = join(dir, "memory.db");
    cfg = defaultConfig();
    cfg.db_path = dbPath;
    cfg.log_level = "error";
    // Small caps + a live auto-promote so the dry run exercises eviction and
    // the promotion path that also emits events.
    cfg.consolidation.caps = {
      working: 3,
      episodic: 5,
      semantic: 10,
      procedural: 5,
      global: 20,
    };
    cfg.consolidation.auto_promote = true;
    cfg.consolidation.light_prune_every_n_writes = 0;
    cfg.retain.min_importance = {
      working: 0.05,
      episodic: 0.1,
      semantic: 0.2,
      procedural: 0.3,
    };

    const seed = createApp({ cfg });
    for (let i = 0; i < 10; i++) {
      await seed.memory.retain({
        content: `Working scratch item ${i}: currently checking subsystem-${i} behaviour in detail.`,
        tier: "working",
        importance: 0.3,
        namespace: "ro",
        skip_merge: true,
      });
    }
    await seed.memory.retain({
      content: "The deployment target is fly.io for every backend service.",
      tier: "semantic",
      importance: 0.8,
      namespace: "ro",
      skip_merge: true,
    });
    await seed.memory.retain({
      content: "The deployment target is render.com for every backend service.",
      tier: "semantic",
      importance: 0.85,
      namespace: "ro",
      skip_merge: true,
    });
    seed.close();

    before = snapshot();
    expect(before.memories).toBeGreaterThan(0);
    expect(before.events).toBeGreaterThan(0);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the database byte-identical after a full inspector session", async () => {
    const app = createApp({ cfg, dbPath, readonly: true });
    try {
      const overview = await buildOverview(app, "database");
      expect(overview.read_only).toBe(true);
      expect(overview.total_active).toBe(before.memories);

      const result = await app.consolidation.prune({
        dry_run: true,
        namespace: "ro",
      });
      // The dry run must actually find work, or this asserts nothing.
      expect(result.archived).toBeGreaterThan(0);
      expect(result.details.length).toBeGreaterThan(0);
    } finally {
      app.close();
    }

    const after = snapshot();
    expect(after.memories).toBe(before.memories);
    expect(after.events).toBe(before.events);
    expect(after.hash).toBe(before.hash);
  });

  it("absorbs the telemetry writes a dry run emits anyway", async () => {
    const app = createApp({ cfg, dbPath, readonly: true });
    try {
      await app.consolidation.prune({ dry_run: true, namespace: "ro" });
      const store = app.store as ReadOnlyStore;
      // prune() always emits a 'prune' event and dry-run promote emits its own.
      // A zero here would mean the guard is untested, not that it is unneeded.
      expect(store.suppressedWrites).toBeGreaterThan(0);
    } finally {
      app.close();
    }
  });

  it("refuses mutations loudly rather than silently dropping them", async () => {
    const app = createApp({ cfg, dbPath, readonly: true });
    try {
      const store = app.store;
      const first = (await store.list({ namespace: "ro", limit: 1 }))[0];
      expect(first).toBeTruthy();

      await expect(store.archive(first.id)).rejects.toThrow(ReadOnlyViolationError);
      await expect(
        store.update(first.id, { importance: 0.1 }),
      ).rejects.toThrow(ReadOnlyViolationError);
      await expect(store.purgeArchivedOlderThan("2000-01-01T00:00:00.000Z")).rejects.toThrow(
        ReadOnlyViolationError,
      );
      expect(() => store.vacuum()).toThrow(ReadOnlyViolationError);

      // delete() is no longer on the port, so there is nothing here to refuse.
      // The guarantee moved from a runtime throw to an absence: the inspector
      // holds a MemoryStore, and a MemoryStore cannot hard-delete a row. Assert
      // the absence, so re-adding delete() to the port fails here rather than
      // quietly restoring an unaudited removal path.
      expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();
      expect(
        (store as unknown as Record<string, unknown>).deleteUnaudited,
      ).toBeUndefined();
    } finally {
      app.close();
    }

    expect(snapshot().hash).toBe(before.hash);
  });

  it("reports the same tier counts as the stats command", async () => {
    const app = createApp({ cfg, dbPath, readonly: true });
    try {
      const stats = await app.store.stats(app.cfg.default_namespace);
      const overview = await buildOverview(app, "database");
      for (const tier of overview.tiers) {
        expect(tier.active).toBe(stats.active_by_tier[tier.tier]);
        expect(tier.cap).toBe(cfg.consolidation.caps[tier.tier]);
      }
      expect(overview.archived).toBe(stats.archived);
    } finally {
      app.close();
    }
  });
});
