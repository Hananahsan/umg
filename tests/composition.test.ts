import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";

/**
 * End-to-end write path, in sequence, asserting on the outcome rather than the parts.
 *
 * Every individual piece of the FTS stack had passing unit tests while the
 * composition was broken for every real install, so this exercises the whole
 * chain: retain -> near-duplicate merge -> contradiction supersede -> prune.
 * It doubles as documentation of the intended write path.
 */
describe("write path composition", () => {
  let dir: string;
  let app: UmgApp;

  const FACT = "The production database uses PostgreSQL for primary storage";
  const NEAR_DUPLICATE = "The production database uses PostgreSQL for primary storage layer";
  const CONTRADICTION = "Actually the production database uses MySQL for primary storage";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-composition-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.retain.min_importance.semantic = 0.3;
    // Pinned to the pre-0.2.3 default so the composed path still has a merge
    // step to exercise. The shipped default is a safety value (0.95) under
    // which this near-duplicate stays split by design — see
    // MERGE_SAFETY_THRESHOLD and tests/merge-safety.test.ts.
    cfg.consolidation.merge_threshold = 0.82;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges a near-duplicate, supersedes a contradiction, then decays on prune", async () => {
    const ns = "composition";

    // 1. First write lands as a new memory.
    const first = await app.memory.retain({
      content: FACT,
      tier: "semantic",
      importance: 0.9,
      namespace: ns,
    });
    expect(first.action).toBe("created");
    expect(await activeCount(ns)).toBe(1);

    // 2. A near-duplicate folds into it instead of creating a second row.
    const duplicate = await app.memory.retain({
      content: NEAR_DUPLICATE,
      tier: "semantic",
      importance: 0.85,
      namespace: ns,
    });
    expect(duplicate.action).toBe("merged");
    expect(duplicate.merged_into).toBe(first.id);
    expect(await activeCount(ns)).toBe(1);

    const afterMerge = (await app.memory.list({ namespace: ns }))[0];
    expect(afterMerge.parent_ids.length).toBeGreaterThan(0);

    // 3. A contradiction supersedes rather than merges: the old claim is archived
    //    and the new one carries the lineage pointer.
    const contradiction = await app.memory.retain({
      content: CONTRADICTION,
      tier: "semantic",
      importance: 0.9,
      namespace: ns,
    });
    expect(contradiction.action).toBe("superseded");
    expect(await activeCount(ns)).toBe(1);

    const survivor = (await app.memory.list({ namespace: ns }))[0];
    expect(survivor.id).toBe(contradiction.id);
    expect(survivor.supersedes_id).toBe(first.id);
    expect(survivor.content).toMatch(/MySQL/i);

    const superseded = await app.store.get(first.id!);
    expect(superseded?.status).toBe("archived");

    // 4. Age the survivor so prune has decay to apply, then prune.
    await app.store.update(survivor.id, {
      last_accessed_at: daysAgo(45),
      created_at: daysAgo(45),
    });
    const decayBefore = (await app.store.get(survivor.id))!.decay_score;

    const pruned = await app.consolidation.prune({ namespace: ns });

    expect(pruned.decayed).toBeGreaterThan(0);
    const decayAfter = (await app.store.get(survivor.id))!.decay_score;
    expect(decayAfter).toBeLessThan(decayBefore);

    // 5. Final state: three writes, one active memory, one archived predecessor.
    expect(await activeCount(ns)).toBe(1);
    const archived = await app.memory.list({ namespace: ns, status: "archived" });
    expect(archived.map((m) => m.id)).toContain(first.id);

    // 6. The survivor is reachable through the read path, ranked by BM25.
    //    Merge and supersede both score with Jaccard, so without this step the
    //    whole flow still passes with FTS silently disabled — which is exactly
    //    how the original bug survived a green suite.
    expect(app.store.isFtsAvailable()).toBe(true);
    const recalled = await app.memory.recall({ query: "MySQL primary storage", namespace: ns });
    expect(recalled.count).toBeGreaterThan(0);
    expect(recalled.memories[0].id).toBe(survivor.id);
    expect(recalled.memories[0].score_breakdown).toHaveProperty("fts");
  });

  async function activeCount(namespace: string): Promise<number> {
    return (await app.memory.list({ namespace })).length;
  }

  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }
});
