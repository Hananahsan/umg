import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import {
  defaultConfig,
  MERGE_MIN_CONFIDENCE,
  MERGE_THRESHOLD,
  type UmgConfig,
} from "../src/config.js";
import { resolveWriteConflict } from "../src/services/contradiction.js";
import { resolveMerge } from "../src/services/merge-policy.js";
import {
  DUPLICATE,
  MUST_NOT_COLLAPSE,
  SCOPE_DISTINCT,
  UNRELATED,
} from "./fixtures/labeled-pairs.js";
import {
  MECHANICS_MERGE_MIN_CONFIDENCE,
  MECHANICS_MERGE_THRESHOLD,
} from "./fixtures/merge-tuning.js";

/**
 * Merge discards a memory, so it needs the same care supersede gets.
 *
 * The guarantee these tests pin is that a distinct fact is never silently
 * deleted, and that the guarantee is *structural* — it comes from
 * resolveMerge's vetoes, not from the threshold being set high. That is why
 * the corpus is replayed at a threshold well below the shipped default.
 */

/** Far below the shipped pre-filter: nothing here may depend on the threshold. */
const RECKLESS_THRESHOLD = 0.4;

describe("merge safety", () => {
  let dir: string;
  let app: UmgApp;

  const build = (overrides: (c: UmgConfig) => void = () => {}): UmgApp => {
    const cfg = defaultConfig();
    cfg.db_path = join(dir, `${Math.random().toString(36).slice(2)}.db`);
    cfg.log_level = "error";
    cfg.consolidation.light_prune_every_n_writes = 0;
    cfg.consolidation.auto_promote = false;
    overrides(cfg);
    return createApp({ cfg });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-merge-safety-"));
    app = build();
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedPair = async (ns: string, a: string, b: string): Promise<void> => {
    for (const content of [a, b]) {
      await app.memory.retain({
        content,
        tier: "semantic",
        namespace: ns,
        skip_merge: true,
      });
    }
  };

  it("keeps the defaults at the calibrated values", () => {
    expect(app.cfg.consolidation.merge_threshold).toBe(MERGE_THRESHOLD);
    expect(app.cfg.consolidation.merge_min_confidence).toBe(MERGE_MIN_CONFIDENCE);
    // The pre-filter must sit above the highest unrelated pair in the corpus
    // (0.4722) so those never reach the confidence gate at all.
    expect(MERGE_THRESHOLD).toBeGreaterThan(0.4722);
  });

  it.each(MUST_NOT_COLLAPSE)(
    "never destroys a distinct fact at the default: $note",
    async ({ a, b }) => {
      await seedPair("d", a, b);
      await app.consolidation.prune({ namespace: "d" });
      const left = await app.store.list({
        namespace: "d",
        status: "active",
        limit: 10,
      });
      expect(left.map((m) => m.content).sort()).toEqual([a, b].sort());
    },
  );

  /**
   * The property step 3 exists for. Previously the only thing between a
   * distinct fact and deletion was the threshold, so the threshold had to be
   * high enough to disable merging entirely. Now scope divergence, differing
   * value slots and two-sided content veto a merge however similar the pair
   * looks — so the same corpus must survive a threshold that would otherwise
   * collapse most of it.
   */
  it.each(MUST_NOT_COLLAPSE)(
    "survives a reckless threshold: $note",
    async ({ a, b }) => {
      app.close();
      app = build((c) => {
        c.consolidation.merge_threshold = RECKLESS_THRESHOLD;
      });
      await seedPair("reckless", a, b);
      await app.consolidation.prune({ namespace: "reckless" });
      const left = await app.store.list({
        namespace: "reckless",
        status: "active",
        limit: 10,
      });
      expect(left.map((m) => m.content).sort()).toEqual([a, b].sort());
    },
  );

  it.each(DUPLICATE)("merges a genuine duplicate: $note", async ({ a, b }) => {
    // Mechanics, not policy: at the shipped 0.95 default merge does not fire
    // at all, so this pins a threshold where the algorithm can be observed.
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });
    await seedPair("dup", a, b);
    await app.consolidation.prune({ namespace: "dup" });
    const left = await app.store.list({
      namespace: "dup",
      status: "active",
      limit: 10,
    });
    expect(left).toHaveLength(1);
    expect(left[0].parent_ids.length).toBeGreaterThan(0);
  });

  it("records why a merge was withheld instead of silently skipping", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = RECKLESS_THRESHOLD;
    });
    const { a, b } = SCOPE_DISTINCT[0];
    await seedPair("why", a, b);
    const result = await app.consolidation.prune({
      namespace: "why",
      dry_run: true,
    });

    const withheld = result.details.find((d) => d.action === "merge_deferred");
    expect(withheld, "expected a merge_deferred record").toBeTruthy();
    expect(withheld?.reason).toBe("scope_divergent");
    expect(String(withheld?.detail)).toContain("staging");
  });

  it("stamps merge_deferred on the write path too", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = RECKLESS_THRESHOLD;
    });
    const { a, b } = SCOPE_DISTINCT[0];
    await app.memory.retain({ content: a, tier: "semantic", namespace: "wp" });
    const second = await app.memory.retain({
      content: b,
      tier: "semantic",
      namespace: "wp",
    });

    expect(second.action).toBe("created");
    expect(second.memory?.metadata?.merge_deferred).toBe(true);
    expect(second.memory?.metadata?.merge_reason).toBe("scope_divergent");
  });

  it("does not let --aggressive lower the bar", async () => {
    const { a, b } = SCOPE_DISTINCT[0];
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
    expect(
      await app.store.list({ namespace: "exact", status: "active", limit: 10 }),
    ).toHaveLength(2);

    await app.consolidation.prune({ namespace: "exact" });
    expect(
      await app.store.list({ namespace: "exact", status: "active", limit: 10 }),
    ).toHaveLength(1);
  });

  /**
   * The measurement the calibration rests on, kept executable so it cannot
   * drift silently.
   *
   * Two claims: raw similarity does NOT separate the classes (which is why a
   * threshold alone can never be the safety mechanism), and confidence — after
   * the structural vetoes — DOES, with the band the constants were chosen from.
   */
  it("records the separation the thresholds are calibrated against", async () => {
    const measure = async (
      a: string,
      b: string,
    ): Promise<{ similarity: number; confidence: number; reason: string }> => {
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
      const similarity = sim[0]?.score ?? 0;
      const conflict = resolveWriteConflict(a, b, similarity, 0.5);
      // Thresholds zeroed so the gates, not the numbers, decide.
      const m = resolveMerge(a, b, similarity, conflict, 0, 0);
      return { similarity, confidence: m.confidence, reason: m.reason };
    };

    const dup = [];
    for (const p of DUPLICATE) dup.push(await measure(p.a, p.b));
    const unrelated = [];
    for (const p of UNRELATED) unrelated.push(await measure(p.a, p.b));

    // Pairs vetoed outright are safe at any number and do not constrain it.
    const gated = unrelated.filter(
      (r) => r.reason !== "differing_values" && r.reason !== "scope_divergent",
    );

    const minDupSim = Math.min(...dup.map((r) => r.similarity));
    const maxUnrelSim = Math.max(...gated.map((r) => r.similarity));
    const minDupConf = Math.min(...dup.map((r) => r.confidence));
    const maxUnrelConf = Math.max(...gated.map((r) => r.confidence));

    // Similarity alone leaves almost no room — this is the whole reason the
    // threshold could not simply be tuned.
    expect(minDupSim - maxUnrelSim).toBeLessThan(0.2);

    // Confidence, after the vetoes, opens a real band.
    expect(minDupConf - maxUnrelConf).toBeGreaterThan(0.25);

    // And the shipped values sit inside it.
    expect(MERGE_MIN_CONFIDENCE).toBeGreaterThan(maxUnrelConf);
    expect(MERGE_MIN_CONFIDENCE).toBeLessThanOrEqual(minDupConf);
    expect(MERGE_THRESHOLD).toBeGreaterThan(maxUnrelSim);
  });
});
