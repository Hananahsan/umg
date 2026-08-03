import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, type UmgApp } from "../src/app.js";
import { createMcpServer } from "../src/mcp/server.js";
import { defaultConfig } from "../src/config.js";
import { VERSION } from "../src/util/version.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("MCP server", () => {
  let dir: string;
  let app: UmgApp;
  let client: Client;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "umg-mcp-"));
    const cfg = defaultConfig();
    cfg.db_path = join(dir, "test.db");
    cfg.log_level = "error";
    app = createApp({ cfg });

    const server = createMcpServer(app);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("advertises the package version in the handshake", () => {
    // This drifted once: the handshake said 0.1.0 while the package shipped 0.2.1.
    const info = client.getServerVersion();
    expect(info?.name).toBe("umg");
    expect(info?.version).toBe(pkg.version);
  });

  it("derives VERSION from package.json", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toBe("0.0.0-unknown");
  });

  it("reports fts_available through umg://stats", async () => {
    const res = await client.readResource({ uri: "umg://stats" });
    const stats = JSON.parse(res.contents[0].text as string) as {
      fts_available: boolean;
      db_size_warn: boolean;
    };
    // Surfaced where people actually look — the stderr warning went unread.
    expect(stats).toHaveProperty("fts_available");
    expect(stats.fts_available).toBe(true);
  });

  it("exposes list_memories as a tool", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("list_memories");
  });
});
