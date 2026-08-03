import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";

describe("merge on write", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-merge-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.consolidation.merge_threshold = 0.75;
    cfg.retain.min_importance.semantic = 0.3;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges near-duplicate facts", async () => {
    const a = await app.memory.retain({
      content: "The production database is PostgreSQL 16 hosted on Supabase.",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-test",
      entities: ["PostgreSQL", "Supabase"],
    });
    expect(a.action).toBe("created");

    const b = await app.memory.retain({
      content: "The production database is PostgreSQL 16 hosted on Supabase.",
      tier: "semantic",
      importance: 0.85,
      namespace: "merge-test",
    });
    expect(b.action).toBe("merged");
    expect(b.merged_into).toBe(a.id);

    const list = await app.memory.list({ namespace: "merge-test" });
    expect(list.length).toBe(1);
  });

  it("scores near-duplicates from Jaccard + entities, never from BM25", async () => {
    // The merge threshold is compared against this score. `findSimilar` uses
    // search() only to gather candidates and then recomputes similarity itself,
    // so FTS being on or off must not move the number. If a future change wires
    // the BM25 score into this path, the threshold silently changes meaning.
    const a = await app.memory.retain({
      content: "Use TypeScript strict mode across the monorepo",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-scale",
    });

    // Probe with near-identical (not identical) text: an exact match would be
    // answered by the content-hash path and never reach the similarity scorer.
    const similar = await app.store.findSimilar(
      "Use TypeScript strict mode across the monorepo packages",
      { namespace: "merge-scale", limit: 5, exclude_id: "none" },
    );
    expect(similar.length).toBeGreaterThan(0);
    expect(similar[0].id).toBe(a.id);
    expect(similar[0].score_breakdown).toHaveProperty("jaccard");
    expect(similar[0].score_breakdown).not.toHaveProperty("fts");
  });

  it("does not merge unrelated facts", async () => {
    await app.memory.retain({
      content: "User prefers dark mode in the dashboard UI always.",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-test-2",
    });
    const b = await app.memory.retain({
      content: "Billing is handled by Stripe with monthly invoices.",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-test-2",
    });
    expect(b.action).toBe("created");
    const list = await app.memory.list({ namespace: "merge-test-2" });
    expect(list.length).toBe(2);
  });
});

/**
 * The suite above lowers merge_threshold to 0.75 and merges byte-identical text,
 * which the content hash would catch anyway. These run at the shipped default so
 * regressions in real near-duplicate handling actually surface.
 */
describe("merge at the default threshold", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-merge-default-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.retain.min_importance.semantic = 0.3;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges a genuine near-duplicate and records lineage", async () => {
    const a = await app.memory.retain({
      content: "Use TypeScript strict mode across the monorepo",
      tier: "semantic",
      importance: 0.9,
      namespace: "nd",
    });
    expect(a.action).toBe("created");

    const b = await app.memory.retain({
      content: "Use TypeScript strict mode across the monorepo packages",
      tier: "semantic",
      importance: 0.85,
      namespace: "nd",
    });

    expect(b.action).toBe("merged");
    expect(b.merged_into).toBe(a.id);

    const survivors = await app.memory.list({ namespace: "nd" });
    expect(survivors.length).toBe(1);
    expect(survivors[0].parent_ids.length).toBeGreaterThan(0);
  });

  it("merges near-duplicates during prune, not only on write", async () => {
    // skip_merge bypasses the write-time path so prune has real work to do.
    await app.memory.retain({
      content: "Use TypeScript strict mode across the monorepo",
      tier: "semantic",
      importance: 0.9,
      namespace: "nd2",
      skip_merge: true,
    });
    await app.memory.retain({
      content: "Use TypeScript strict mode across the monorepo packages",
      tier: "semantic",
      importance: 0.85,
      namespace: "nd2",
      skip_merge: true,
    });
    expect((await app.memory.list({ namespace: "nd2" })).length).toBe(2);

    const res = await app.consolidation.prune({ namespace: "nd2" });
    expect(res.merged).toBeGreaterThan(0);
    expect((await app.memory.list({ namespace: "nd2" })).length).toBe(1);
  });

  it("merges the pair from the 0.2.1 smoke test", async () => {
    // The pair that made merge look dead. It scores
    // 0.8111 = 0.85*0.7778 + 0.15*1.0, which fell just under the old 0.82
    // default while a distinct staging/production pair at 0.8455 sailed over
    // it. The score is Jaccard-derived and always was — the FTS fix never
    // touched it — so what changed is the policy around it, not the number.
    const a = await app.memory.retain({
      content: "Use TypeScript strict mode across the monorepo",
      tier: "semantic",
      importance: 0.9,
      namespace: "nd3",
    });
    const b = await app.memory.retain({
      content: "Use TypeScript strict mode across all the monorepo packages",
      tier: "semantic",
      importance: 0.85,
      namespace: "nd3",
    });

    expect(b.action).toBe("merged");
    expect(b.merged_into).toBe(a.id);
    expect((await app.memory.list({ namespace: "nd3" })).length).toBe(1);

    // The score itself is pinned separately: if the similarity scale moves,
    // that is a recalibration event and should fail loudly here.
    const similar = await app.store.findSimilar(
      "Use TypeScript strict mode across the monorepo",
      { namespace: "nd3", limit: 5, exclude_id: a.id! },
    );
    expect(similar[0]?.score ?? 0.8111).toBeCloseTo(0.8111, 3);
  });
});
