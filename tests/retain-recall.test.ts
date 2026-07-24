import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";

describe("retain / recall", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-test-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    // lower gates for test fixtures
    cfg.retain.min_importance.episodic = 0.2;
    cfg.retain.min_importance.semantic = 0.3;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("retains and recalls a semantic preference", async () => {
    const r = await app.memory.retain({
      content: "User preference: always use TypeScript strict mode for new projects.",
      tier: "semantic",
      importance: 0.9,
      tags: ["preference", "typescript"],
      namespace: "test",
    });
    expect(r.action).toBe("created");
    expect(r.id).toBeTruthy();

    const recall = await app.memory.recall({
      query: "TypeScript preference",
      namespace: "test",
    });
    expect(recall.count).toBeGreaterThan(0);
    expect(recall.memories[0].content).toMatch(/TypeScript/i);
  });

  it("rejects low-information content", async () => {
    const r = await app.memory.retain({
      content: "ok",
      tier: "episodic",
    });
    expect(r.action).toBe("rejected");
  });

  it("auto-tiers decision language as semantic", async () => {
    const r = await app.memory.retain({
      content: "Decision: we use Supabase for auth and Postgres storage.",
      importance: 0.85,
      namespace: "test",
    });
    expect(r.action).toBe("created");
    expect(r.tier).toBe("semantic");
  });

  it("lists memories by namespace", async () => {
    await app.memory.retain({
      content: "Remember: deploy only via the main branch CI pipeline.",
      importance: 0.8,
      namespace: "proj-a",
    });
    await app.memory.retain({
      content: "Remember: staging URL is staging.example.com",
      importance: 0.8,
      namespace: "proj-b",
    });
    const a = await app.memory.list({ namespace: "proj-a" });
    expect(a.every((m) => m.namespace === "proj-a")).toBe(true);
    expect(a.length).toBeGreaterThanOrEqual(1);
  });
});
