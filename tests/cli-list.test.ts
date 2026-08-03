import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";
import { defaultConfig } from "../src/config.js";

const run = promisify(execFile);
const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

/**
 * `list_memories` shipped as an MCP tool with no CLI equivalent, so both
 * `umg0 list` and `umg0 list-memories` fell through to the help text. These
 * spawn the real CLI so a routing regression cannot slip back in.
 */
describe("umg0 list", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "umg-cli-"));
    dbPath = join(dir, "cli.db");
    const cfg = defaultConfig();
    cfg.db_path = dbPath;
    cfg.log_level = "error";
    cfg.retain.min_importance.semantic = 0.3;
    const app = createApp({ cfg });
    await app.memory.retain({
      content: "Deploy only from the main branch CI pipeline",
      tier: "semantic",
      importance: 0.9,
      namespace: "proj-a",
    });
    await app.memory.retain({
      content: "The staging environment mirrors production weekly",
      tier: "episodic",
      importance: 0.8,
      namespace: "proj-b",
    });
    // Single-writer discipline: release the DB before the CLI opens it.
    app.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function cli(args: string[]): Promise<{ count: number; memories: Array<Record<string, unknown>> }> {
    const { stdout } = await run("npx", ["tsx", ENTRY, ...args], {
      env: { ...process.env, UMG_DB_PATH: dbPath, UMG_LOG_LEVEL: "error" },
    });
    return JSON.parse(stdout);
  }

  it("lists every namespace by default", async () => {
    const out = await cli(["list"]);
    expect(out.count).toBe(2);
  });

  it("filters by namespace and tier", async () => {
    const out = await cli(["list", "--namespace", "proj-a", "--tier", "semantic"]);
    expect(out.count).toBe(1);
    expect(out.memories[0].namespace).toBe("proj-a");
    expect(out.memories[0].tier).toBe("semantic");
  });

  it("honours --limit", async () => {
    const out = await cli(["list", "--limit", "1"]);
    expect(out.count).toBe(1);
  });

  it("accepts the list-memories alias", async () => {
    const out = await cli(["list-memories", "--namespace", "proj-b"]);
    expect(out.count).toBe(1);
    expect(out.memories[0].namespace).toBe("proj-b");
  });
});
