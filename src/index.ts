#!/usr/bin/env node
import { createApp } from "./app.js";
import { startMcpServer } from "./mcp/server.js";
import { log } from "./util/log.js";

function printHelp(): void {
  const help = `
umg — Unified Memory Gateway

Usage:
  umg mcp              Start MCP server on stdio (default)
  umg prune [--dry-run] [--aggressive] [--namespace <ns>]
  umg stats
  umg retain --content "..." [--tier semantic] [--namespace global]
  umg recall --query "..." [--limit 8]
  umg help

Env:
  UMG_DB_PATH          SQLite path (default ~/.umg/memory.db)
  UMG_NAMESPACE        Default namespace
  UMG_LOG_LEVEL        debug|info|warn|error
  UMG_LLM_ENABLED      true to enable LLM reflect
  UMG_LLM_API_KEY      API key for optional LLM reflect
  UMG_LLM_BASE_URL     OpenAI-compatible base URL
  UMG_LLM_MODEL        Model name

Config file (optional):
  ./umg.config.yaml or ~/.umg/config.yaml
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
  const app = createApp({ dbPath });

  try {
    switch (cmd) {
      case "mcp": {
        await startMcpServer(app);
        // keep process alive via stdio
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
