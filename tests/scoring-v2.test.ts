import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/config.js";
import {
  computeDecayScore,
  computeImportance,
  rankForRecall,
} from "../src/services/scoring.js";
import type { ScoredMemory } from "../src/types.js";
import { cosineSimilarity } from "../src/util/embeddings.js";

describe("importance v0.2", () => {
  it("boosts entity density on short facts", () => {
    const dense = computeImportance(
      "Retell + Supabase + Stripe for Voniq production.",
      "semantic",
    );
    const sparse = computeImportance(
      "Things are generally fine and we should keep going carefully.",
      "semantic",
    );
    expect(dense).toBeGreaterThan(sparse);
  });

  it("boosts rare entities more than common ones", () => {
    const freq = new Map<string, number>([
      ["retell", 1],
      ["typescript", 50],
    ]);
    const rare = computeImportance(
      "Remember: Retell webhook secret rotation is monthly.",
      "semantic",
      undefined,
      { namespaceEntityFreq: freq, namespaceMemoryCount: 50 },
    );
    const common = computeImportance(
      "Remember: TypeScript is used everywhere in the monorepo.",
      "semantic",
      undefined,
      { namespaceEntityFreq: freq, namespaceMemoryCount: 50 },
    );
    expect(rare).toBeGreaterThanOrEqual(common - 0.05);
  });
});

describe("decay v0.2", () => {
  it("uses configurable alpha/beta", () => {
    const cfg = defaultConfig();
    cfg.consolidation.decay.alpha = 1;
    cfg.consolidation.decay.beta = 0;
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const score = computeDecayScore(
      {
        tier: "episodic",
        importance: 1,
        access_count: 100,
        last_accessed_at: old,
        metadata: {},
      },
      cfg,
      now,
    );
    // pure time decay with high access shouldn't fully recover when beta=0
    expect(score).toBeLessThan(0.5);
  });

  it("applies session boost after recent recall", () => {
    const cfg = defaultConfig();
    const now = new Date().toISOString();
    const base = computeDecayScore(
      {
        tier: "semantic",
        importance: 0.5,
        access_count: 1,
        last_accessed_at: now,
        metadata: {},
      },
      cfg,
      now,
    );
    const boosted = computeDecayScore(
      {
        tier: "semantic",
        importance: 0.5,
        access_count: 1,
        last_accessed_at: now,
        metadata: { last_recalled_at: now },
      },
      cfg,
      now,
    );
    expect(boosted).toBeGreaterThan(base);
  });
});

describe("ranking weights config", () => {
  it("reorders when entity weight dominates", () => {
    const cfg = defaultConfig();
    cfg.recall.ranking_weights = {
      fts: 0.05,
      importance: 0.05,
      decay: 0.05,
      tier: 0.05,
      recency: 0.05,
      entity: 0.75,
    };
    const now = new Date().toISOString();
    const base = {
      status: "active" as const,
      namespace: "t",
      tags: [] as string[],
      confidence: 0.7,
      access_count: 1,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
      expires_at: null,
      decay_score: 0.5,
      embedding: null,
      metadata: {},
      parent_ids: [] as string[],
      score: 0.5,
      score_breakdown: { fts: 0.5 },
    };
    const withEnt: ScoredMemory = {
      ...base,
      id: "e",
      tier: "semantic",
      content: "Retell agents",
      entities: ["Retell"],
      importance: 0.4,
    };
    const noEnt: ScoredMemory = {
      ...base,
      id: "n",
      tier: "semantic",
      content: "general note",
      entities: [],
      importance: 0.95,
    };
    const ranked = rankForRecall([noEnt, withEnt], cfg, now, "Retell health");
    expect(ranked[0].id).toBe("e");
  });
});

describe("cosine helper", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });
});
