import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";

describe("merge on write", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-merge-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.consolidation.merge_threshold = 0.75;
    cfg.retain.min_importance.semantic = 0.3;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("merges near-duplicate facts", async () => {
    const a = await app.memory.retain({
      content: "The production database is PostgreSQL 16 hosted on Supabase.",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-test",
      entities: ["PostgreSQL", "Supabase"],
    });
    expect(a.action).toBe("created");

    const b = await app.memory.retain({
      content: "The production database is PostgreSQL 16 hosted on Supabase.",
      tier: "semantic",
      importance: 0.85,
      namespace: "merge-test",
    });
    expect(b.action).toBe("merged");
    expect(b.merged_into).toBe(a.id);

    const list = await app.memory.list({ namespace: "merge-test" });
    expect(list.length).toBe(1);
  });

  it("does not merge unrelated facts", async () => {
    await app.memory.retain({
      content: "User prefers dark mode in the dashboard UI always.",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-test-2",
    });
    const b = await app.memory.retain({
      content: "Billing is handled by Stripe with monthly invoices.",
      tier: "semantic",
      importance: 0.9,
      namespace: "merge-test-2",
    });
    expect(b.action).toBe("created");
    const list = await app.memory.list({ namespace: "merge-test-2" });
    expect(list.length).toBe(2);
  });
});
