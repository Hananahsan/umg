#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bootstrapApp } from "./app.js";
import { startMcpServer } from "./mcp/server.js";
import { log } from "./util/log.js";

function printHelp(): void {
  const help = `
umg — Unified Memory Gateway (v0.2)

Usage:
  umg mcp              Start MCP server on stdio (default)
  umg prune [--dry-run] [--aggressive] [--namespace <ns>]
  umg stats
  umg compact [--export-archives]
  umg retain --content "..." [--tier semantic] [--namespace global]
  umg recall --query "..." [--limit 8]
  umg reflect --text "..."
  umg promote --ids id1,id2 [--title "..."] [--dry-run]
  umg help

Env:
  UMG_DB_PATH          SQLite path (default ~/.umg/memory.db)
  UMG_NAMESPACE        Default namespace
  UMG_LOG_LEVEL        debug|info|warn|error
  UMG_LLM_ENABLED      true to enable LLM reflect
  UMG_EMBEDDINGS_ENABLED  true for optional hybrid embeddings
  UMG_HARD_ISOLATION   true to force namespace on recall

Config: ./umg.config.yaml or ~/.umg/config.yaml

Single-writer: one process per DB file. Share one MCP server across clients.
`.trim();
  process.stderr.write(help + "\n");
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "mcp";
  const args = cmd === argv[0] ? argv.slice(1) : argv;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  const dbPath = getFlag(args, "--db") ?? process.env.UMG_DB_PATH;
  const skipStartupPrune =
    process.env.UMG_SKIP_STARTUP_PRUNE === "1" ||
    process.env.UMG_SKIP_STARTUP_PRUNE === "true" ||
    hasFlag(args, "--skip-startup-prune");
  const app = await bootstrapApp({ dbPath, skipStartupPrune });

  try {
    switch (cmd) {
      case "mcp": {
        await startMcpServer(app);
        return;
      }
      case "prune": {
        const result = await app.consolidation.prune({
          dry_run: hasFlag(args, "--dry-run"),
          aggressive: hasFlag(args, "--aggressive"),
          namespace: getFlag(args, "--namespace"),
        });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        break;
      }
      case "stats": {
        const stats = await app.store.stats(app.cfg.default_namespace);
        process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
        break;
      }
      case "compact": {
        const before = app.store.dbFileSizeBytes();
        if (hasFlag(args, "--export-archives")) {
          const archives = await app.store.listArchived(10_000);
          const dir = join(homedir(), ".umg", "exports");
          mkdirSync(dir, { recursive: true });
          const path = join(dir, `archive-${Date.now()}.jsonl`);
          const lines = archives.map((m) => JSON.stringify(m)).join("\n");
          writeFileSync(path, lines + (lines ? "\n" : ""), "utf8");
          process.stderr.write(`exported ${archives.length} archives → ${path}\n`);
        }
        app.store.vacuum();
        const after = app.store.dbFileSizeBytes();
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              size_before: before,
              size_after: after,
              saved_bytes: Math.max(0, before - after),
            },
            null,
            2,
          ) + "\n",
        );
        break;
      }
      case "retain": {
        const content = getFlag(args, "--content");
        if (!content) {
          process.stderr.write("retain requires --content\n");
          process.exitCode = 1;
          break;
        }
        const result = await app.memory.retain({
          content,
          tier: getFlag(args, "--tier") as
            | "working"
            | "episodic"
            | "semantic"
            | "procedural"
            | undefined,
          namespace: getFlag(args, "--namespace"),
          source: "cli",
        });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        break;
      }
      case "recall": {
        const query = getFlag(args, "--query");
        if (!query) {
          process.stderr.write("recall requires --query\n");
          process.exitCode = 1;
          break;
        }
        const limit = getFlag(args, "--limit");
        const result = await app.memory.recall({
          query,
          namespace: getFlag(args, "--namespace"),
          limit: limit ? Number(limit) : undefined,
        });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        break;
      }
      case "reflect": {
        const text = getFlag(args, "--text");
        if (!text) {
          process.stderr.write("reflect requires --text\n");
          process.exitCode = 1;
          break;
        }
        const result = await app.reflect.reflect({
          text,
          namespace: getFlag(args, "--namespace"),
        });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        break;
      }
      case "promote": {
        const idsRaw = getFlag(args, "--ids");
        if (!idsRaw) {
          process.stderr.write("promote requires --ids id1,id2\n");
          process.exitCode = 1;
          break;
        }
        const result = await app.promotion.promoteToSkill({
          memory_ids: idsRaw.split(",").map((s) => s.trim()).filter(Boolean),
          title: getFlag(args, "--title"),
          namespace: getFlag(args, "--namespace"),
          dry_run: hasFlag(args, "--dry-run"),
        });
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
        break;
      }
      default:
        process.stderr.write(`Unknown command: ${cmd}\n`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    log.error("fatal", { error: String(err) });
    process.stderr.write(String(err) + "\n");
    process.exitCode = 1;
  } finally {
    if (cmd !== "mcp") {
      app.close();
    }
  }
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
