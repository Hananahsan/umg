import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { UmgApp } from "../src/app.js";
import { createDemoApp, DEMO_NAMESPACE } from "../src/inspector/demo-dataset.js";
import { buildOverview } from "../src/inspector/api.js";
import { ReadOnlyViolationError } from "../src/store/readonly.js";
import { MEMORY_TIERS } from "../src/types.js";

/**
 * The demo dataset exists so the replay always has something dramatic to show.
 * If it stops producing every operation type, the recording target silently
 * degrades — so assert each one is present rather than just that it runs.
 */
describe("inspector demo dataset", () => {
  let app: UmgApp;
  let actions: Record<string, number>;

  beforeAll(async () => {
    app = await createDemoApp();
    const result = await app.consolidation.prune({
      dry_run: true,
      namespace: DEMO_NAMESPACE,
    });
    actions = {};
    for (const d of result.details) {
      const key = String(d.action);
      actions[key] = (actions[key] ?? 0) + 1;
    }
  });

  afterAll(() => app.close());

  it("populates all four tiers", async () => {
    const overview = await buildOverview(app, "demo");
    for (const tier of MEMORY_TIERS) {
      const row = overview.tiers.find((t) => t.tier === tier);
      expect(row, `missing tier ${tier}`).toBeTruthy();
      expect(row!.active, `tier ${tier} is empty`).toBeGreaterThan(0);
    }
    expect(overview.total_active).toBeGreaterThan(30);
  });

  it("puts at least one tier over cap so eviction pressure is visible", async () => {
    const overview = await buildOverview(app, "demo");
    expect(overview.tiers.some((t) => t.health === "over_cap")).toBe(true);
  });

  it("produces every consolidation operation on a dry run", () => {
    // decay recompute
    expect(actions.decay ?? 0).toBeGreaterThan(0);
    // planted near-duplicates
    expect(actions.merge ?? 0).toBeGreaterThan(0);
    // planted contradictions
    expect(actions.supersede ?? 0).toBeGreaterThan(0);
    // stale entries below the score floor
    expect(actions.evict_floor ?? 0).toBeGreaterThan(0);
    // tier over cap
    expect(actions.evict_cap ?? 0).toBeGreaterThan(0);
    // hard expiry
    expect(actions.expire ?? 0).toBeGreaterThan(0);
    // procedural over cap stays protected
    expect(actions.cap_skip_procedural ?? 0).toBeGreaterThan(0);
  });

  it("plants both contradiction kinds so supersede reasons differ", async () => {
    const result = await app.consolidation.prune({
      dry_run: true,
      namespace: DEMO_NAMESPACE,
    });
    const conflicts = result.details
      .filter((d) => d.action === "supersede")
      .map((d) => String(d.conflict));
    expect(conflicts.some((c) => c.startsWith("conflicting_values"))).toBe(true);
    expect(conflicts).toContain("boolean_flip");
  });

  it("is served read-only and never touches disk", async () => {
    const overview = await buildOverview(app, "demo");
    expect(overview.source).toBe("demo");
    expect(overview.db_path).not.toContain("/");
    expect(overview.db_size_bytes).toBe(0);

    const first = (await app.store.list({ namespace: DEMO_NAMESPACE, limit: 1 }))[0];
    await expect(app.store.archive(first.id)).rejects.toThrow(ReadOnlyViolationError);
  });
});
