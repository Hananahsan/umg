import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { computeDecayScore } from "../src/services/scoring.js";

describe("pruning and decay", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-prune-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.retain.min_importance.working = 0.05;
    cfg.retain.min_importance.episodic = 0.1;
    cfg.consolidation.caps.working = 5;
    cfg.consolidation.caps.episodic = 8;
    cfg.consolidation.caps.global = 20;
    cfg.consolidation.eviction_floor = 0.5;
    cfg.consolidation.grace_period_days = 0;
    cfg.consolidation.auto_promote = false;
    cfg.consolidation.light_prune_every_n_writes = 0;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("computes lower decay for old unused memories", () => {
    const cfg = app.cfg;
    const fresh = computeDecayScore(
      {
        tier: "episodic",
        importance: 0.5,
        access_count: 5,
        last_accessed_at: new Date().toISOString(),
      },
      cfg,
    );
    const stale = computeDecayScore(
      {
        tier: "episodic",
        importance: 0.5,
        access_count: 0,
        last_accessed_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      },
      cfg,
    );
    expect(stale).toBeLessThan(fresh);
  });

  it("enforces tier caps by archiving lowest decay", async () => {
    // Create more working memories than cap
    for (let i = 0; i < 12; i++) {
      await app.memory.retain({
        content: `Working scratch note number ${i} about task context ${i} details here.`,
        tier: "working",
        importance: 0.2 + (i % 5) * 0.05,
        namespace: "cap-test",
        skip_merge: true,
      });
    }

    const before = await app.memory.list({
      namespace: "cap-test",
      tiers: ["working"],
    });
    expect(before.length).toBeGreaterThan(5);

    const result = await app.consolidation.prune({ namespace: "cap-test" });
    expect(result.archived).toBeGreaterThan(0);

    const after = await app.memory.list({
      namespace: "cap-test",
      tiers: ["working"],
    });
    expect(after.length).toBeLessThanOrEqual(app.cfg.consolidation.caps.working);
  });

  it("dry_run does not archive", async () => {
    for (let i = 0; i < 10; i++) {
      await app.memory.retain({
        content: `Episodic event log entry ${i} happened during testing of prune dry run.`,
        tier: "episodic",
        importance: 0.3,
        namespace: "dry",
        skip_merge: true,
      });
    }
    const before = (await app.memory.list({ namespace: "dry" })).length;
    await app.consolidation.prune({ namespace: "dry", dry_run: true });
    const after = (await app.memory.list({ namespace: "dry" })).length;
    expect(after).toBe(before);
  });

  it("expires memories past expires_at", async () => {
    const r = await app.memory.retain({
      content: "Temporary working context that should expire soon for this unit test.",
      tier: "working",
      importance: 0.4,
      namespace: "exp",
    });
    expect(r.id).toBeTruthy();
    // Force expiry
    await app.store.update(r.id!, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    await app.consolidation.prune({ namespace: "exp", light: true });
    const m = await app.store.get(r.id!);
    expect(m?.status).toBe("archived");
  });

  it("multi-pass merge consolidates near-duplicates", async () => {
    const ns = "multipass";
    // Three near-identical facts that should collapse under multi-pass
    await app.memory.retain({
      content: "The staging API base URL is https://staging.example.com/v1 for clients.",
      tier: "semantic",
      importance: 0.8,
      namespace: ns,
      skip_merge: true,
    });
    await app.memory.retain({
      content: "The staging API base URL is https://staging.example.com/v1 for all clients.",
      tier: "semantic",
      importance: 0.8,
      namespace: ns,
      skip_merge: true,
    });
    await app.memory.retain({
      content: "Staging API base URL is https://staging.example.com/v1 for clients.",
      tier: "semantic",
      importance: 0.8,
      namespace: ns,
      skip_merge: true,
    });

    const before = await app.memory.list({ namespace: ns, tiers: ["semantic"] });
    expect(before.length).toBe(3);

    const result = await app.consolidation.prune({ namespace: ns });
    const after = await app.memory.list({ namespace: ns, tiers: ["semantic"] });

    expect(result.merged + result.archived).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before.length);
    const mergeDetails = result.details.filter((d) => d.action === "merge");
    if (mergeDetails.length > 0) {
      expect(mergeDetails[0].reason).toBe("near_duplicate");
      expect(mergeDetails[0].pass).toBeDefined();
    }
  });

  it("does not score-floor evict procedural when protected", async () => {
    const r = await app.memory.retain({
      content:
        "Skill: deploy checklist\nWhen to use: production deploys\nLessons:\n1. Run migrations first.",
      tier: "procedural",
      importance: 0.9,
      namespace: "proc-prot",
      skip_merge: true,
    });
    await app.store.update(r.id!, {
      decay_score: 0.01,
      last_accessed_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
    });
    app.cfg.consolidation.evict_procedural = false;
    app.cfg.consolidation.eviction_floor = 0.5;
    app.cfg.consolidation.grace_period_days = 0;

    await app.consolidation.prune({ namespace: "proc-prot" });
    const m = await app.store.get(r.id!);
    expect(m?.status).toBe("active");
  });

  it("includes stable reason codes on cap eviction details", async () => {
    // Keep decay above score floor so only tier-cap eviction fires
    app.cfg.consolidation.eviction_floor = 0.05;
    for (let i = 0; i < 12; i++) {
      await app.memory.retain({
        content: `Working scratch UNIQUE_TOKEN_${i}_${"x".repeat(8 + i)} xyz${i} abc${i * 7} task-${i}-context.`,
        tier: "working",
        importance: 0.9,
        namespace: "reason-ns",
        skip_merge: true,
      });
    }
    const result = await app.consolidation.prune({ namespace: "reason-ns" });
    const after = await app.memory.list({
      namespace: "reason-ns",
      tiers: ["working"],
    });
    expect(after.length).toBeLessThanOrEqual(app.cfg.consolidation.caps.working);
    const cap = result.details.find((d) => d.action === "evict_cap");
    expect(cap).toBeTruthy();
    expect(cap?.reason).toBe("cap_tier");
  });

  /**
   * A dry run is a prediction of the real run. These two guarded different
   * bugs that made it lie, both of which the inspector renders directly.
   */
  describe("dry run predicts the real run", () => {
    it("reports each merge and supersede once, not once per pass", async () => {
      const ns = "dry-passes";
      for (const content of [
        "The staging API base URL is https://staging.example.com/v1 for all clients.",
        "The staging API base URL is https://staging.example.com/v1 for clients.",
        "The staging API base URL is https://staging.example.com/v1 for all clients today.",
      ]) {
        await app.memory.retain({
          content,
          tier: "semantic",
          importance: 0.8,
          namespace: ns,
          skip_merge: true,
        });
      }

      const dry = await app.consolidation.prune({ namespace: ns, dry_run: true });
      const pairs = dry.details
        .filter((d) => d.action === "merge" || d.action === "supersede")
        .map((d) => `${d.action}:${d.into}->${d.from}`);

      // Vacuity guard. This test was written while merge was silently not
      // firing, so `dry.merged === real.merged` would have been 0 === 0 and
      // looked green while asserting nothing. Fail loudly if the fixture stops
      // producing merges instead of quietly becoming a no-op.
      expect(dry.merged).toBeGreaterThan(0);
      expect(pairs.length).toBeGreaterThan(0);

      // findSimilar reads the database, which on a dry run still shows the
      // loser as active — each pass used to re-detect the same pair.
      expect(new Set(pairs).size).toBe(pairs.length);

      const real = await app.consolidation.prune({ namespace: ns });
      expect(dry.merged).toBe(real.merged);
      expect(dry.archived).toBe(real.archived);
    });

    it("applies recomputed decay before the score-floor check", async () => {
      const ns = "dry-decay";
      app.cfg.consolidation.eviction_floor = 0.2;
      app.cfg.consolidation.grace_period_days = 0;

      const r = await app.memory.retain({
        content: "An old episodic note about a vendor call that nobody revisited.",
        tier: "episodic",
        importance: 0.4,
        namespace: ns,
        skip_merge: true,
      });
      // Stale access time with a still-high stored decay_score: the prune must
      // recompute and act on the new value, not the stored one.
      await app.store.update(r.id!, {
        decay_score: 0.9,
        last_accessed_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const dry = await app.consolidation.prune({ namespace: ns, dry_run: true });
      expect(dry.details.some((d) => d.action === "evict_floor" && d.id === r.id)).toBe(
        true,
      );

      await app.consolidation.prune({ namespace: ns });
      expect((await app.store.get(r.id!))?.status).toBe("archived");
    });
  });
});
