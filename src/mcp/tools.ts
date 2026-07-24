import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { UmgApp } from "../app.js";
import type { MemoryTier } from "../types.js";
import { truncate } from "../util/text.js";

const TierSchema = z.enum(["working", "episodic", "semantic", "procedural"]);

function textResult(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function compactMemory(m: {
  id: string;
  tier: string;
  content: string;
  summary?: string | null;
  importance: number;
  decay_score: number;
  namespace: string;
  tags: string[];
  score?: number;
}) {
  return {
    id: m.id,
    tier: m.tier,
    namespace: m.namespace,
    importance: Number(m.importance.toFixed(3)),
    decay: Number(m.decay_score.toFixed(3)),
    score: m.score !== undefined ? Number(m.score.toFixed(3)) : undefined,
    tags: m.tags,
    content: truncate(m.content, 400),
    summary: m.summary ? truncate(m.summary, 160) : undefined,
  };
}

export function registerTools(server: McpServer, app: UmgApp): void {
  server.tool(
    "retain",
    "Store a memory in the hierarchical store. Use for facts, preferences, decisions, and important session notes. Low-value content may be rejected. Near-duplicates are merged.",
    {
      content: z.string().describe("Memory content to store"),
      tier: TierSchema.optional().describe(
        "Memory tier. Omit to auto-classify (working|episodic|semantic|procedural)",
      ),
      namespace: z
        .string()
        .optional()
        .describe("Namespace for isolation, e.g. project:voniq"),
      importance: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Optional importance 0-1 (blended with system score)"),
      tags: z.array(z.string()).optional(),
      entities: z.array(z.string()).optional(),
      session_id: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async (args) => {
      const result = await app.memory.retain({
        content: args.content,
        tier: args.tier as MemoryTier | undefined,
        namespace: args.namespace,
        importance: args.importance,
        tags: args.tags,
        entities: args.entities,
        session_id: args.session_id,
        metadata: args.metadata,
        source: "agent",
      });
      return textResult({
        action: result.action,
        id: result.id,
        tier: result.tier,
        merged_into: result.merged_into,
        superseded_id: result.superseded_id,
        reason: result.reason,
        memory: result.memory ? compactMemory(result.memory) : undefined,
      });
    },
  );

  server.tool(
    "recall",
    "Retrieve ranked memories relevant to a query. Call at session start and when you need prior context.",
    {
      query: z.string().describe("What to search for"),
      namespace: z.string().optional(),
      tiers: z.array(TierSchema).optional(),
      limit: z.number().int().min(1).max(25).optional(),
      include_working: z.boolean().optional().default(true),
    },
    async (args) => {
      const result = await app.memory.recall({
        query: args.query,
        namespace: args.namespace,
        tiers: args.tiers as MemoryTier[] | undefined,
        limit: args.limit,
        include_working: args.include_working,
      });
      return textResult({
        query: result.query,
        count: result.count,
        memories: result.memories.map(compactMemory),
      });
    },
  );

  server.tool(
    "reflect",
    "Extract durable memories from conversation text or notes and optionally write them back. Prefer this after a productive session.",
    {
      text: z.string().describe("Conversation transcript, notes, or session dump"),
      namespace: z.string().optional(),
      mode: z.enum(["extract", "summarize_session"]).optional(),
      auto_retain: z
        .boolean()
        .optional()
        .describe("If true (default), retain extracted candidates"),
      session_id: z.string().optional(),
    },
    async (args) => {
      const result = await app.reflect.reflect({
        text: args.text,
        namespace: args.namespace,
        mode: args.mode,
        auto_retain: args.auto_retain,
        session_id: args.session_id,
      });
      return textResult({
        mode: result.mode,
        candidates: result.candidates.map((c) => ({
          content: truncate(c.content, 300),
          tier: c.tier,
          importance: Number(c.importance.toFixed(3)),
          tags: c.tags,
          entities: c.entities,
          reason: c.reason,
        })),
        retained: result.retained.map((r) => ({
          action: r.action,
          id: r.id,
          tier: r.tier,
          reason: r.reason,
        })),
      });
    },
  );

  server.tool(
    "list_memories",
    "List stored memories with optional filters.",
    {
      namespace: z.string().optional(),
      tier: TierSchema.optional(),
      tags: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(100).optional().default(20),
      offset: z.number().int().min(0).optional().default(0),
    },
    async (args) => {
      const memories = await app.memory.list({
        namespace: args.namespace,
        tiers: args.tier ? [args.tier as MemoryTier] : undefined,
        tags: args.tags,
        limit: args.limit,
        offset: args.offset,
      });
      return textResult({
        count: memories.length,
        memories: memories.map(compactMemory),
      });
    },
  );

  server.tool(
    "prune",
    "Run hierarchical consolidation: recompute decay, merge near-duplicates, evict low-value memories under caps. Prefer dry_run first when unsure.",
    {
      dry_run: z.boolean().optional().default(false),
      namespace: z.string().optional(),
      aggressive: z.boolean().optional().default(false),
    },
    async (args) => {
      const result = await app.consolidation.prune({
        dry_run: args.dry_run,
        namespace: args.namespace,
        aggressive: args.aggressive,
      });
      return textResult(result);
    },
  );

  server.tool(
    "promote_to_skill",
    "Promote one or more memories into a durable procedural skill memory. Use dry_run to propose without archiving sources.",
    {
      memory_ids: z.array(z.string()).describe("Source memory IDs"),
      title: z.string().optional(),
      content: z.string().optional().describe("Optional skill body override"),
      tags: z.array(z.string()).optional(),
      namespace: z.string().optional(),
      dry_run: z
        .boolean()
        .optional()
        .describe("If true, propose skill without writing or archiving"),
    },
    async (args) => {
      const result = await app.promotion.promoteToSkill({
        memory_ids: args.memory_ids,
        title: args.title,
        content: args.content,
        tags: args.tags,
        namespace: args.namespace,
        dry_run: args.dry_run,
      });
      return textResult({
        id: result.id,
        source_ids: result.source_ids,
        archived_sources: result.archived_sources,
        dry_run: result.dry_run,
        rejected: result.rejected,
        rejected_reason: result.rejected_reason,
        memory: result.memory?.content
          ? compactMemory(result.memory)
          : undefined,
      });
    },
  );
}
