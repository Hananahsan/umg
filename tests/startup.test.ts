import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type UmgApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";
import { runStartupMaintenance } from "../src/startup.js";

describe("startup maintenance", () => {
  let dir: string;
  let app: UmgApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "umg-start-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    cfg.consolidation.light_prune_every_n_writes = 0;
    app = createApp({ cfg });
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs light prune on first boot", async () => {
    const r = await runStartupMaintenance(app);
    expect(r.pruned).toBe(true);
    expect(r.reason).toBe("first_boot");
    expect(app.store.getMeta("last_prune_at")).toBeTruthy();
  });

  it("skips when last prune is recent", async () => {
    await runStartupMaintenance(app, { force: true });
    const r = await runStartupMaintenance(app);
    expect(r.pruned).toBe(false);
    expect(r.reason).toBe("recent_prune");
  });

  it("runs when last prune is stale", async () => {
    app.store.setMeta(
      "last_prune_at",
      new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    );
    const r = await runStartupMaintenance(app);
    expect(r.pruned).toBe(true);
    expect(r.reason).toBe("stale");
  });
});
