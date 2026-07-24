import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { entityOverlapScore, extractEntities } from "../src/util/entities.js";
import { rankForRecall } from "../src/services/scoring.js";
import type { ScoredMemory } from "../src/types.js";

describe("entity extraction and overlap", () => {
  it("extracts tech entities from query", () => {
    const e = extractEntities("How do we deploy Retell with Supabase?");
    expect(e.map((x) => x.toLowerCase())).toEqual(
      expect.arrayContaining(["retell", "supabase"]),
    );
  });

  it("scores full entity hit higher than none", () => {
    const q = "Retell webhook health check";
    const withEnt = entityOverlapScore(q, {
      entities: ["Retell", "Supabase"],
      content: "x",
    });
    const without = entityOverlapScore(q, {
      entities: ["Stripe"],
      content: "billing only",
    });
    expect(withEnt).toBeGreaterThan(without);
  });
});

describe("entity boost in recall ranking", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-ent-"));
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

  it("ranks entity-matching memory above non-matching peer", () => {
    const now = new Date().toISOString();
    const base = {
      status: "active" as const,
      namespace: "t",
      tags: [] as string[],
      source: "test",
      session_id: null,
      confidence: 0.7,
      access_count: 1,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
      expires_at: null,
      decay_score: 0.7,
      embedding: null,
      metadata: {},
      parent_ids: [] as string[],
      supersedes_id: null,
      score: 0.5,
      score_breakdown: { fts: 0.5 },
    };

    const withEntity: ScoredMemory = {
      ...base,
      id: "1",
      tier: "semantic",
      content: "Retell agent webhooks must stay healthy after deploy.",
      summary: "Retell webhooks",
      entities: ["Retell"],
      importance: 0.55,
    };
    const withoutEntity: ScoredMemory = {
      ...base,
      id: "2",
      tier: "semantic",
      content: "Always prefer careful deploys and health checks in general.",
      summary: "general deploy",
      entities: [],
      importance: 0.75, // higher importance, no entity
    };

    const ranked = rankForRecall(
      [withoutEntity, withEntity],
      app.cfg,
      now,
      "Retell webhook health",
    );
    expect(ranked[0].id).toBe("1");
    expect(ranked[0].score_breakdown?.entity).toBeGreaterThan(0);
  });

  it("recall prefers entity-tagged retain in integration", async () => {
    await app.memory.retain({
      content: "Decision: Retell voice agents use the production webhook URL.",
      tier: "semantic",
      importance: 0.7,
      namespace: "ent-int",
      entities: ["Retell"],
      skip_merge: true,
    });
    await app.memory.retain({
      content: "Decision: always run migrations before any production deploy.",
      tier: "semantic",
      importance: 0.9,
      namespace: "ent-int",
      entities: [],
      skip_merge: true,
    });

    const r = await app.memory.recall({
      query: "Retell webhook",
      namespace: "ent-int",
      limit: 5,
    });
    expect(r.count).toBeGreaterThan(0);
    expect(r.memories[0].content).toMatch(/Retell/i);
  });
});
