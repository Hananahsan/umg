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
});
