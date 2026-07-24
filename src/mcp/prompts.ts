import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MEMORY_USAGE = `You have UMG (Unified Memory Gateway) tools for durable hierarchical memory.

## Hierarchy
- working: short-lived task scratch (expires fast)
- episodic: specific events / session experiences
- semantic: durable facts, preferences, decisions
- procedural: reusable skills / how-to lessons

## When to call tools
1. Session start → recall(query: project + task). Prefer semantic + procedural.
2. New durable fact → retain(content, tier when sure, namespace project:<name>).
3. Corrections → retain the new truth; UMG supersedes contradictory priors.
4. Session end → reflect(text: bullet decisions/preferences, auto_retain: true).
5. Proven playbook → promote_to_skill(memory_ids).
6. Noisy store → prune(dry_run: true) then prune().

## Writing good memories
- One fact per retain
- Concrete, reusable wording
- Include entity names (services, projects)
- Never store secrets (API keys, tokens, passwords)
- Do not dump full transcripts into retain — use reflect

## Namespaces
- project:<name> for project facts
- global (default) for personal preferences
`;

const SESSION_START = `At the start of this session:
1. Call recall with the project name and current task.
2. Briefly apply relevant preferences and prior decisions.
3. Do not re-ask for facts already in memory unless they may have changed.
`;

const SESSION_END = `At the end of this session (or when asked to wrap up):
1. Draft 3–8 bullets: decisions, preferences, corrections, durable lessons.
2. Call reflect with that text and auto_retain: true.
3. If a reusable procedure emerged, promote_to_skill on the key memory ids.
4. Optionally prune(dry_run: true) if you stored a lot of noise.
`;

/**
 * MCP prompts — portable agent guidance (Claude Code / Cursor can surface these).
 */
export function registerPrompts(server: McpServer): void {
  server.prompt(
    "memory-usage",
    "How to use UMG hierarchical memory tools effectively",
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: MEMORY_USAGE,
          },
        },
      ],
    }),
  );

  server.prompt(
    "session-start",
    "Checklist for loading UMG memory at session start",
    {
      project: z.string().optional().describe("Project or namespace hint"),
      task: z.string().optional().describe("Current task summary"),
    },
    async (args) => {
      const project = args.project ?? "current project";
      const task = args.task ?? "current task";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                SESSION_START +
                `\nContext:\n- project: ${project}\n- task: ${task}\n\nSuggested recall query: "${project} ${task}"`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "session-end",
    "Checklist for reflecting and writing back durable memories at session end",
    {
      notes: z
        .string()
        .optional()
        .describe("Optional session notes to include in the prompt"),
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              SESSION_END +
              (args.notes
                ? `\n\nSession notes to consider:\n${args.notes}`
                : ""),
          },
        },
      ],
    }),
  );
}
