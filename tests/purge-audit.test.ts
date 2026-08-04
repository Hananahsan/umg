import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";

/**
 * The purge is the only sanctioned way a memory's content leaves the database
 * for good. The retention invariant reads a memory's disappearance as a
 * violation unless the id shows up in `purged_ids`, which makes that array an
 * exception list — and an exception list is only as good as its completeness.
 *
 * `details` is capped at 100 entries for payload size. If purged_ids ever
 * inherited that cap, clause A would fire on every purge past the hundredth,
 * and the obvious-looking fix would be to weaken clause A. So the cap is
 * tested rather than assumed, above the boundary where it would bite.
 */

const RETENTION_DAYS = 90;
const DAY = 86_400_000;

describe("purge is auditable", () => {
  let dir: string;
  let app: UmgApp;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-purge-"));
    dbPath = join(dir, "test.db");
    const cfg = defaultConfig();
    cfg.db_path = dbPath;
    cfg.log_level = "error";
    cfg.consolidation.archive_retention_days = RETENTION_DAYS;
    cfg.consolidation.auto_promote = false;
    cfg.consolidation.light_prune_every_n_writes = 0;
    cfg.retain.auto_tier = false;
    cfg.retain.min_importance = {
      working: 0, episodic: 0, semantic: 0, procedural: 0,
    };
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Archived rows whose updated_at is older than the retention cutoff. */
  const seedStaleArchives = async (n: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await app.memory.retain({
        content: `archived note number ${i} about the ${i} deployment window`,
        tier: "episodic",
        namespace: "purge",
        skip_merge: true,
      });
      ids.push(r.id);
    }
    const stale = new Date(Date.now() - (RETENTION_DAYS + 10) * DAY).toISOString();
    const db = new Database(dbPath);
    const stmt = db.prepare(
      "UPDATE memories SET status='archived', updated_at=? WHERE id=?",
    );
    for (const id of ids) stmt.run(stale, id);
    db.close();
    return ids;
  };

  const activeAndArchivedCount = (): number => {
    const db = new Database(dbPath, { readonly: true });
    const n = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
    db.close();
    return n;
  };

  it("reports every purged id, with no cap at the details limit", async () => {
    // 120 is deliberately above the 100-entry `details` truncation.
    const seeded = await seedStaleArchives(120);
    expect(activeAndArchivedCount()).toBe(120);

    const result = await app.consolidation.prune({});

    expect(result.purged).toBe(120);
    expect(result.purged_ids).toHaveLength(120);
    expect(result.purged_ids.length).toBeGreaterThan(result.details.length);
    expect([...result.purged_ids].sort()).toEqual([...seeded].sort());
    expect(activeAndArchivedCount()).toBe(0);
  });

  it("keeps purged and purged_ids.length in agreement", async () => {
    await seedStaleArchives(7);
    const result = await app.consolidation.prune({});
    expect(result.purged).toBe(result.purged_ids.length);
    expect(result.purged).toBe(7);
  });

  it("reports no ids when nothing is past retention", async () => {
    // Archived, but recently — inside the retention window.
    const r = await app.memory.retain({
      content: "a recently archived note about the staging certificate",
      tier: "episodic",
      namespace: "purge",
      skip_merge: true,
    });
    const db = new Database(dbPath);
    db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(r.id);
    db.close();

    const result = await app.consolidation.prune({});
    expect(result.purged).toBe(0);
    expect(result.purged_ids).toEqual([]);
    expect(activeAndArchivedCount()).toBe(1);
  });

  it("returns the ids that were actually deleted, not the ids matched", async () => {
    // RETURNING binds the report to the delete. A row that does not meet the
    // cutoff must be absent from both the database delta and the report.
    const stale = await seedStaleArchives(3);
    const fresh = await app.memory.retain({
      content: "an archived note still inside the retention window",
      tier: "episodic",
      namespace: "purge",
      skip_merge: true,
    });
    const db = new Database(dbPath);
    db.prepare("UPDATE memories SET status='archived' WHERE id=?").run(fresh.id);
    db.close();

    const result = await app.consolidation.prune({});
    expect([...result.purged_ids].sort()).toEqual([...stale].sort());
    expect(result.purged_ids).not.toContain(fresh.id);

    const after = new Database(dbPath, { readonly: true });
    const remaining = (after.prepare("SELECT id FROM memories").all() as Array<{ id: string }>)
      .map((r) => r.id);
    after.close();
    expect(remaining).toEqual([fresh.id]);
  });

  it("purges nothing on a dry run and reports nothing", async () => {
    await seedStaleArchives(4);
    const result = await app.consolidation.prune({ dry_run: true });
    expect(result.purged_ids).toEqual([]);
    expect(result.purged).toBe(0);
    expect(activeAndArchivedCount()).toBe(4);
  });

  it("does not put the id list in the event log, which truncates itself", async () => {
    await seedStaleArchives(5);
    await app.consolidation.prune({});

    const events = await app.store.listEvents(50);
    const prune = events.find((e) => e.kind === "prune");
    expect(prune).toBeTruthy();
    // The count survives; the ids do not. purgeOldEvents runs from emitEvent,
    // so the log trims its own history and cannot hold the audit record.
    expect(prune!.detail.purged).toBe(5);
    expect(prune!.detail.purged_ids).toBe(5);
    expect(Array.isArray(prune!.detail.purged_ids)).toBe(false);
  });
});
