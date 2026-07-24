import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const MEMORY_USAGE = `You have UMG (Unified Memory Gateway) — hierarchical, hygiene-first local memory.

## Hierarchy
- working: short-lived task scratch
- episodic: specific events / experiences
- semantic: durable facts, preferences, decisions
- procedural: reusable skills (promote only when proven)

## Ranking (how recall works)
Recall ranks by: FTS + importance + decay + tier + recency + **entity overlap**.
Name entities (products, services, people) in queries to surface the right memories.
Weights are configurable offline — no embeddings required by default.

## Write policy (additive-first)
- retain durable facts immediately (semantic when sure)
- Near-duplicates merge; clear contradictions supersede (confidence ≥ 0.75)
- Ambiguous conflicts: both kept until prune consolidates — do not fear dual short-term facts
- Never dump full transcripts — use reflect

## Session flow
1. Start → recall(project + task); prefer semantic + procedural
2. During → retain corrections and decisions
3. End → reflect with bullets of decisions/preferences (auto_retain true)
4. Proven playbook → promote_to_skill (dry_run first if unsure)
5. Noise → prune(dry_run: true) then prune()

## Hygiene
- One fact per retain when possible
- No secrets (keys, tokens, passwords)
- Prefer lean semantic/procedural over endless episodic dumps
`;

const SESSION_START = `Load UMG memory for this session:

1. Call recall with: project name + current task (+ key entity names).
2. Apply preferences and prior decisions without re-asking.
3. If hard isolation is on, pass the project namespace explicitly.
4. Keep working-tier scratch out of long-term stores unless durable.

Do not re-explain known stack/preferences if recall returns them.
`;

const SESSION_END = `Write back durable memory before ending:

1. List 3–8 bullets: decisions, preferences, corrections, lessons (with entity names).
2. Call reflect(text, auto_retain: true). Prefer labeled lines:
   Decision: ...
   Preference: ...
3. If a reusable procedure emerged, promote_to_skill (or dry_run first).
4. If you stored a lot of noise, prune(dry_run: true) then prune().

Quality bar: only durable, reusable facts — not chat filler.
`;

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "memory-usage",
    "How to use UMG hierarchical memory (hygiene-first, entity-aware recall)",
    async () => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: MEMORY_USAGE },
        },
      ],
    }),
  );

  server.prompt(
    "session-start",
    "Load UMG memory at session start (entity-aware recall)",
    {
      project: z.string().optional().describe("Project or namespace"),
      task: z.string().optional().describe("Current task"),
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
                `\nContext:\n- project: ${project}\n- task: ${task}\n\nSuggested recall: "${project} ${task}"\nNamespace hint: project:${project.replace(/\s+/g, "-").toLowerCase()}`,
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "session-end",
    "Reflect and write durable memories at session end",
    {
      notes: z.string().optional().describe("Session notes to consider"),
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              SESSION_END +
              (args.notes ? `\n\nSession notes:\n${args.notes}` : ""),
          },
        },
      ],
    }),
  );
}
