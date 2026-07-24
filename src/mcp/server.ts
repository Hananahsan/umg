import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { UmgApp } from "../app.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";
import { log } from "../util/log.js";

export async function startMcpServer(app: UmgApp): Promise<void> {
  const server = new McpServer({
    name: "umg",
    version: "0.1.0",
  });

  registerTools(server, app);
  registerPrompts(server);

  server.resource(
    "stats",
    "umg://stats",
    async () => {
      const stats = await app.store.stats(app.cfg.default_namespace);
      return {
        contents: [
          {
            uri: "umg://stats",
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    },
  );

  server.resource(
    "config",
    "umg://config",
    async () => {
      const safe = {
        ...app.cfg,
        reflect: {
          ...app.cfg.reflect,
          llm: {
            ...app.cfg.reflect.llm,
            // never expose secrets
            api_key_env: app.cfg.reflect.llm.api_key_env,
          },
        },
      };
      return {
        contents: [
          {
            uri: "umg://config",
            mimeType: "application/json",
            text: JSON.stringify(safe, null, 2),
          },
        ],
      };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP server listening on stdio");
}
