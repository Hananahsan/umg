#!/usr/bin/env tsx
/**
 * End-to-end smoke of the full UMG MVP path against a temp DB.
 * Run: npm run e2e
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { runStartupMaintenance } from "../src/startup.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`E2E FAIL: ${msg}`);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "umg-e2e-"));
  const cfg = defaultConfig();
  cfg.db_path = join(dir, "e2e.db");
  cfg.log_level = "error";
  cfg.retain.min_importance.semantic = 0.3;
  cfg.retain.min_importance.episodic = 0.2;
  cfg.consolidation.auto_promote = false;
  cfg.consolidation.caps.working = 5;
  cfg.consolidation.light_prune_every_n_writes = 0;

  const app = createApp({ cfg });
  const steps: string[] = [];

  try {
    // 1. Startup prune
    const boot = await runStartupMaintenance(app);
    assert(boot.pruned, "startup prune should run on first boot");
    steps.push("startup_prune");

    // 2. Retain semantic fact
    const r1 = await app.memory.retain({
      content: "Remember: prefer TypeScript strict mode for all new services.",
      tier: "semantic",
      importance: 0.9,
      namespace: "e2e",
      tags: ["typescript"],
    });
    assert(r1.action === "created" && r1.id, "retain semantic");
    steps.push("retain");

    // 3. Recall
    const recall = await app.memory.recall({
      query: "TypeScript preference",
      namespace: "e2e",
    });
    assert(recall.count >= 1, "recall should find memory");
    steps.push("recall");

    // 4. Merge-on-write duplicate
    const r2 = await app.memory.retain({
      content: "Remember: prefer TypeScript strict mode for all new services.",
      tier: "semantic",
      importance: 0.85,
      namespace: "e2e",
    });
    assert(r2.action === "merged", "duplicate should merge");
    steps.push("merge");

    // 5. Reflect extract + retain
    const reflected = await app.reflect.reflect({
      text: `
        Decision: use SQLite FTS5 for local agent memory search.
        Preference: keep the MCP tool surface under ten tools.
      `,
      namespace: "e2e",
      auto_retain: true,
    });
    assert(reflected.candidates.length >= 1, "reflect candidates");
    assert(
      reflected.retained.some((x) => x.action !== "rejected"),
      "reflect retained something",
    );
    steps.push("reflect");

    // 6. Promote to skill
    const list = await app.memory.list({ namespace: "e2e", limit: 20 });
    assert(list.length >= 1, "list memories");
    const promo = await app.promotion.promoteToSkill({
      memory_ids: [list[0].id],
      title: "E2E skill",
      namespace: "e2e",
    });
    assert(promo.memory.tier === "procedural", "promote procedural");
    steps.push("promote");

    // 7. Contradiction / supersede path (best-effort)
    await app.memory.retain({
      content: "Decision: the e2e cache backend uses Redis.",
      tier: "semantic",
      importance: 0.9,
      namespace: "e2e-contra",
    });
    const contra = await app.memory.retain({
      content: "Decision: the e2e cache backend uses Memcached instead.",
      tier: "semantic",
      importance: 0.95,
      namespace: "e2e-contra",
    });
    assert(
      contra.action === "created" ||
        contra.action === "superseded" ||
        contra.action === "merged",
      "contradiction path returns valid action",
    );
    steps.push("contradiction_path");

    // 8. Cap pressure + full prune
    for (let i = 0; i < 8; i++) {
      await app.memory.retain({
        content: `Working scratch note ${i} for e2e cap pressure testing details.`,
        tier: "working",
        importance: 0.25,
        namespace: "e2e",
        skip_merge: true,
      });
    }
    const pruned = await app.consolidation.prune({ namespace: "e2e" });
    assert(typeof pruned.archived === "number", "prune result");
    const working = await app.memory.list({
      namespace: "e2e",
      tiers: ["working"],
    });
    assert(
      working.length <= cfg.consolidation.caps.working,
      "working tier under cap after prune",
    );
    steps.push("prune_caps");

    // 9. Stats + meta
    const stats = await app.store.stats("e2e");
    assert(stats.total_active >= 1, "stats active");
    assert(app.store.getMeta("last_prune_at"), "last_prune_at meta set");
    steps.push("stats");

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          steps,
          total_active: stats.total_active,
          active_by_tier: stats.active_by_tier,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
