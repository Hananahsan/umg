import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { heuristicExtract } from "../src/services/reflect.js";

describe("promotion and reflect", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-promo-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.retain.min_importance.semantic = 0.3;
    cfg.retain.min_importance.episodic = 0.2;
    cfg.retain.min_importance.procedural = 0.5;
    cfg.consolidation.archive_sources_on_promote = true;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("promotes memories to procedural skill", async () => {
    const a = await app.memory.retain({
      content: "When deploying Voniq, always run the Supabase migration check first.",
      tier: "episodic",
      importance: 0.8,
      namespace: "promo",
      tags: ["deploy"],
      entities: ["Voniq", "Supabase"],
    });
    const b = await app.memory.retain({
      content: "After migrations, verify Retell agent webhooks are healthy.",
      tier: "episodic",
      importance: 0.8,
      namespace: "promo",
      tags: ["deploy"],
      entities: ["Retell"],
    });

    const promo = await app.promotion.promoteToSkill({
      memory_ids: [a.id!, b.id!],
      title: "Voniq deploy checklist",
      namespace: "promo",
    });

    expect(promo.id).toBeTruthy();
    expect(promo.memory.tier).toBe("procedural");
    expect(promo.memory.content).toMatch(/Skill:/);
    expect(promo.source_ids).toContain(a.id);

    const skill = await app.store.get(promo.id);
    expect(skill?.tier).toBe("procedural");
  });

  it("heuristic reflect extracts labeled decisions", async () => {
    const text = `
      Decision: use SQLite for local agent memory storage.
      Preference: keep tool surfaces under 10 MCP tools.
      Hello there
      Random noise
    `;
    const candidates = heuristicExtract(text, 5);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates.some((c) => /SQLite/i.test(c.content))).toBe(true);
  });

  it("reflect retains extracted candidates", async () => {
    const result = await app.reflect.reflect({
      text: `
        Decision: the default namespace for personal facts is global.
        Preference: always prune aggressively after large imports.
      `,
      namespace: "reflect-ns",
      auto_retain: true,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    const kept = result.retained.filter((r) => r.action !== "rejected");
    expect(kept.length).toBeGreaterThan(0);
  });
});
