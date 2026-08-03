import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig, MERGE_SAFETY_THRESHOLD } from "../src/config.js";

/**
 * Merge discards a memory on a bare threshold — no confidence gate, no
 * additive fallback, unlike supersede. On the current similarity scale
 * (0.85*jaccard + 0.15*entityOverlap) true duplicates and distinct facts
 * overlap, so the threshold is held high until merge is made fail-safe.
 *
 * These tests pin the property that matters — a distinct fact is never
 * silently deleted — and record the measurements the threshold rests on.
 */

/** Same fact, reworded. Merging these is correct. */
const DUPLICATES: Array<[string, string]> = [
  [
    "Use TypeScript strict mode across the monorepo",
    "Use TypeScript strict mode across all the monorepo packages",
  ],
  [
    "The team standup is at 9:30am every weekday",
    "Team standup is at 9:30am on every weekday",
  ],
  ["Prefer pnpm over npm for installs", "Prefer pnpm over npm for package installs"],
];

/**
 * Different facts sharing a sentence frame. Merging these destroys one of
 * them. None are caught by the contradiction detector today, so the merge
 * threshold is the only thing standing between them and deletion.
 */
const DISTINCT: Array<[string, string]> = [
  [
    "The staging API base URL is https://staging.example.com/v1",
    "The production API base URL is https://api.example.com/v1",
  ],
  [
    "The team standup is at 9:30am every weekday",
    "The team retro is at 4:00pm every Friday",
  ],
  [
    "The billing service owner is the payments team",
    "The search service owner is the discovery team",
  ],
];

describe("merge safety", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-merge-safety-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "m.db");
    cfg.log_level = "error";
    cfg.consolidation.light_prune_every_n_writes = 0;
    cfg.consolidation.auto_promote = false;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedPair = async (
    ns: string,
    a: string,
    b: string,
  ): Promise<void> => {
    for (const content of [a, b]) {
      await app.memory.retain({
        content,
        tier: "semantic",
        namespace: ns,
        skip_merge: true,
      });
    }
  };

  it("keeps the default at the documented safety value", () => {
    expect(app.cfg.consolidation.merge_threshold).toBe(MERGE_SAFETY_THRESHOLD);
    expect(MERGE_SAFETY_THRESHOLD).toBeGreaterThanOrEqual(0.95);
  });

  it.each(DISTINCT)(
    "never destroys a distinct fact: %s",
    async (a: string, b: string) => {
      const ns = `d${a.length}${b.length}`;
      await seedPair(ns, a, b);
      await app.consolidation.prune({ namespace: ns });
      const left = await app.store.list({
        namespace: ns,
        status: "active",
        limit: 10,
      });
      expect(left.map((m) => m.content).sort()).toEqual([a, b].sort());
    },
  );

  it("does not let --aggressive reopen the merge hole", async () => {
    // The staging/production pair scores 0.8455 and used to be collapsed;
    // --aggressive previously shaved 0.05 off the threshold.
    const [a, b] = DISTINCT[0];
    await seedPair("agg", a, b);
    await app.consolidation.prune({ namespace: "agg", aggressive: true });
    const left = await app.store.list({
      namespace: "agg",
      status: "active",
      limit: 10,
    });
    expect(left).toHaveLength(2);
  });

  it("still collapses exact duplicates", async () => {
    const text = "The release train ships every second Tuesday at 14:00 UTC.";
    await seedPair("exact", text, text);
    const before = await app.store.list({
      namespace: "exact",
      status: "active",
      limit: 10,
    });
    expect(before).toHaveLength(2);

    await app.consolidation.prune({ namespace: "exact" });
    const after = await app.store.list({
      namespace: "exact",
      status: "active",
      limit: 10,
    });
    expect(after).toHaveLength(1);
  });

  /**
   * Not an assertion about the right threshold — a record of why there is not
   * one yet. If a future change separates these classes, this test starts
   * failing and the threshold can come down. That is the intended signal.
   */
  it("records that duplicates and distinct facts are not separable today", async () => {
    const score = async (a: string, b: string): Promise<number> => {
      const ns = `s${Math.random().toString(36).slice(2)}`;
      const ra = await app.memory.retain({
        content: a,
        tier: "semantic",
        namespace: ns,
        skip_merge: true,
      });
      await app.memory.retain({
        content: b,
        tier: "semantic",
        namespace: ns,
        skip_merge: true,
      });
      const sim = await app.store.findSimilar(a, {
        namespace: ns,
        limit: 5,
        exclude_id: ra.id,
      });
      return sim[0]?.score ?? 0;
    };

    const dup: number[] = [];
    for (const [a, b] of DUPLICATES) dup.push(await score(a, b));
    const dist: number[] = [];
    for (const [a, b] of DISTINCT) dist.push(await score(a, b));

    // The classes overlap: the best distinct pair outscores the worst
    // duplicate, so no threshold admits all duplicates without also admitting
    // a distinct pair.
    expect(Math.max(...dist)).toBeGreaterThan(Math.min(...dup));

    // And the safety threshold sits above every measured pair, so nothing in
    // this corpus merges by similarity at the default.
    expect(Math.max(...dup, ...dist)).toBeLessThan(MERGE_SAFETY_THRESHOLD);
  });
});
