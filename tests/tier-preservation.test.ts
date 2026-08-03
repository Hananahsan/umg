import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig, type UmgConfig } from "../src/config.js";
import { longerLivedTier, MEMORY_TIERS, type MemoryTier } from "../src/types.js";
import {
  MECHANICS_MERGE_MIN_CONFIDENCE,
  MECHANICS_MERGE_THRESHOLD,
} from "./fixtures/merge-tuning.js";

/**
 * Clause B of the retention invariant: a memory's retention class never
 * silently weakens.
 *
 * This is the bug a content-only audit misses. Merging a `procedural` memory
 * into a `working` row loses no text — and hands the survivor a 24 hour TTL,
 * cap 50 instead of 200, a half-life of 0.5d instead of 730d, and no
 * procedural decay floor. The skill is gone tomorrow.
 *
 * Two things caused it: findSimilar's exact-hash branch ignored opts.tiers
 * entirely, and merging kept the target's tier whatever the incoming one was.
 */

const TEXT = "Skill: rotate the signing keys every quarter using the ops runbook";

describe("tier is never downgraded by a merge", () => {
  let dir: string;
  let app: UmgApp;

  const build = (tune: (c: UmgConfig) => void = () => {}): UmgApp => {
    const cfg = defaultConfig();
    cfg.db_path = join(dir, `${Math.random().toString(36).slice(2)}.db`);
    cfg.log_level = "error";
    cfg.consolidation.light_prune_every_n_writes = 0;
    cfg.consolidation.auto_promote = false;
    // Honour the tier we pass instead of re-deriving it from the text.
    cfg.retain.auto_tier = false;
    cfg.retain.min_importance = {
      working: 0, episodic: 0, semantic: 0, procedural: 0,
    };
    tune(cfg);
    return createApp({ cfg });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-tier-"));
    app = build();
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not let an exact-hash match cross incompatible tiers", async () => {
    // mergeCompatibleTiers("procedural") is ["procedural", "semantic"] —
    // working is not compatible, and the exact-hash branch used to ignore that.
    await app.memory.retain({ content: TEXT, tier: "working", namespace: "x" });
    const second = await app.memory.retain({
      content: TEXT,
      tier: "procedural",
      namespace: "x",
    });

    expect(second.action).toBe("created");
    const rows = await app.store.list({ namespace: "x", limit: 10 });
    expect(rows.map((m) => m.tier).sort()).toEqual(["procedural", "working"]);

    const skill = rows.find((m) => m.tier === "procedural");
    expect(skill?.expires_at ?? null).toBeNull();
  });

  it("keeps the longer-lived tier when compatible tiers collide", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });
    // semantic IS compatible with procedural, so these do merge — and the
    // survivor must come out procedural, not semantic.
    await app.memory.retain({ content: TEXT, tier: "semantic", namespace: "y" });
    const second = await app.memory.retain({
      content: TEXT,
      tier: "procedural",
      namespace: "y",
    });

    expect(second.action).toBe("merged");
    const rows = await app.store.list({ namespace: "y", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe("procedural");
    // An upgraded row that kept the old TTL would still expire.
    expect(rows[0].expires_at ?? null).toBeNull();
  });

  it("never pulls a procedural row down to an incoming semantic write", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });
    await app.memory.retain({ content: TEXT, tier: "procedural", namespace: "z" });
    await app.memory.retain({ content: TEXT, tier: "semantic", namespace: "z" });

    const rows = await app.store.list({ namespace: "z", limit: 10 });
    // mergeCompatibleTiers is asymmetric: procedural lists semantic, semantic
    // does not list procedural. So this direction never merges at all and the
    // two rows coexist. Duplication, but never a downgrade — which is the
    // property under test. (The duplicate is prune's problem, not the write
    // path's.)
    expect(rows.some((m) => m.tier === "procedural")).toBe(true);
    const skill = rows.find((m) => m.tier === "procedural");
    expect(skill?.expires_at ?? null).toBeNull();
  });

  it("preserves tier through a prune-path merge too", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });
    // skip_merge so the write path stays out of it and prune does the merging.
    await app.memory.retain({
      content: TEXT, tier: "semantic", namespace: "p", skip_merge: true,
    });
    await app.memory.retain({
      content: TEXT, tier: "procedural", namespace: "p", skip_merge: true,
    });

    await app.consolidation.prune({ namespace: "p" });
    const active = await app.store.list({
      namespace: "p", status: "active", limit: 10,
    });
    expect(active).toHaveLength(1);
    expect(active[0].tier).toBe("procedural");
    expect(active[0].expires_at ?? null).toBeNull();
  });

  it("reproduces the reported session workflow end to end", async () => {
    // Mid-session the agent jots the lesson unlabelled as a working note; at
    // session end reflect extracts "Skill: <same sentence>", strips the label,
    // and retains the bare sentence as procedural. Those two texts hash the
    // same, which is how the skill used to inherit a 24h TTL.
    app.close();
    app = build((c) => { c.retain.auto_tier = true; });
    const bare =
      "always run database migrations against a staging clone before production";

    await app.memory.retain({ content: bare, tier: "working", namespace: "flow" });
    await app.reflect.reflect({ text: `Skill: ${bare}`, namespace: "flow" });

    const active = await app.store.list({
      namespace: "flow", status: "active", limit: 10,
    });
    const skill = active.find((m) => m.tier === "procedural");
    expect(skill, "the skill must survive as procedural").toBeTruthy();
    expect(skill?.expires_at ?? null).toBeNull();
  });

  /**
   * The tier upgrade mutates an existing row's tier, expires_at and
   * decay_score — a mutation path that did not exist before 0.2.4. Clause D
   * (no active row references a nonexistent row) has to survive it.
   */
  it("keeps references coherent across a tier upgrade", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });

    const base = await app.memory.retain({
      content: TEXT, tier: "semantic", namespace: "r", skip_merge: true,
    });
    const referrer = await app.memory.retain({
      content: "An unrelated fact that will carry a reference to the skill row",
      tier: "semantic", namespace: "r", skip_merge: true,
    });
    await app.store.update(referrer.id!, {
      parent_ids: [base.id!],
      supersedes_id: base.id!,
    });

    // Same text at a longer-lived tier: triggers the upgrade on `base`.
    await app.memory.retain({ content: TEXT, tier: "procedural", namespace: "r" });

    const upgraded = await app.store.get(base.id!);
    expect(upgraded?.id).toBe(base.id); // in-place, so references stay valid
    expect(upgraded?.tier).toBe("procedural");

    const all = await app.store.list({ namespace: "r", limit: 50 });
    const ids = new Set(all.map((m) => m.id));
    const ref = await app.store.get(referrer.id!);
    expect(ref!.parent_ids.every((p) => ids.has(p))).toBe(true);
    expect(ids.has(ref!.supersedes_id!)).toBe(true);
  });

  it("records the upgrade in metadata so it is not a silent change", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });
    await app.memory.retain({ content: TEXT, tier: "semantic", namespace: "m" });
    await app.memory.retain({ content: TEXT, tier: "procedural", namespace: "m" });

    const row = (await app.store.list({ namespace: "m", limit: 10 }))[0];
    expect(row.metadata.tier_upgraded_from).toBe("semantic");
    expect(row.metadata.tier_upgraded_to).toBe("procedural");
    expect(row.metadata.tier_upgraded_at).toBeTruthy();
  });

  it("never shortens an expiry that was extended past the tier default", async () => {
    // An upgrade recomputing expires_at from the tier default alone would
    // revoke a manual extension: an episodic row extended to +1000d came back
    // from a semantic upgrade expiring at created+365d, ~2 years earlier.
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });
    const r = await app.memory.retain({
      content: TEXT, tier: "episodic", namespace: "x2", skip_merge: true,
    });
    const farFuture = new Date(Date.now() + 1000 * 86_400_000).toISOString();
    await app.store.update(r.id!, { expires_at: farFuture });

    await app.memory.retain({ content: TEXT, tier: "semantic", namespace: "x2" });

    const after = await app.store.get(r.id!);
    expect(after!.tier).toBe("semantic");
    expect(Date.parse(after!.expires_at!)).toBeGreaterThanOrEqual(
      Date.parse(farFuture),
    );
  });

  it("mergeCompatibleTiers stays asymmetric on purpose", async () => {
    app.close();
    app = build((c) => {
      c.consolidation.merge_threshold = MECHANICS_MERGE_THRESHOLD;
      c.consolidation.merge_min_confidence = MECHANICS_MERGE_MIN_CONFIDENCE;
    });
    // procedural -> semantic absorbs (and upgrades).
    await app.memory.retain({ content: TEXT, tier: "semantic", namespace: "a1" });
    const up = await app.memory.retain({
      content: TEXT, tier: "procedural", namespace: "a1",
    });
    expect(up.action).toBe("merged");

    // semantic -> procedural must NOT absorb: reaching the procedural tier is
    // promote_to_skill's job, and it gates on recalls, sessions and importance.
    // A hash collision must not be a back door around those gates.
    await app.memory.retain({ content: TEXT, tier: "procedural", namespace: "a2" });
    const down = await app.memory.retain({
      content: TEXT, tier: "semantic", namespace: "a2",
    });
    expect(down.action).toBe("created");
  });

  it("longerLivedTier orders every tier pair consistently", () => {
    for (const a of MEMORY_TIERS) {
      for (const b of MEMORY_TIERS) {
        const winner = longerLivedTier(a, b);
        expect([a, b]).toContain(winner);
        // Symmetric, and never picks the shorter-lived side.
        expect(longerLivedTier(b, a)).toBe(winner);
      }
    }
    const ordered: MemoryTier[] = ["working", "episodic", "semantic", "procedural"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(longerLivedTier(ordered[i], ordered[i + 1])).toBe(ordered[i + 1]);
    }
  });
});
