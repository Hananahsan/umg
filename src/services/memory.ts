import type { UmgConfig } from "../config.js";
import type { MemoryStore } from "../store/interface.js";
import { newMemoryId } from "../store/memory-ids.js";
import type {
  ListFilter,
  Memory,
  MemoryTier,
  RecallResult,
  RetainResult,
  ScoredMemory,
} from "../types.js";
import {
  autoTier,
  computeDecayScore,
  computeImportance,
  defaultExpiresAt,
  isLowInformation,
  rankForRecall,
} from "./scoring.js";
import { resolveWriteConflict } from "./contradiction.js";
import { resolveMerge } from "./merge-policy.js";
import { emitEvent } from "../observability/events.js";
import { log } from "../util/log.js";
import { extractEntities } from "../util/entities.js";
import { embedText } from "../util/embeddings.js";
import { nowIso, summarize, truncate, uniqueStrings } from "../util/text.js";
import type { ConsolidationService } from "./consolidation.js";

export interface RetainInput {
  content: string;
  tier?: MemoryTier;
  namespace?: string;
  importance?: number;
  tags?: string[];
  entities?: string[];
  session_id?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  skip_merge?: boolean;
}

export interface RecallInput {
  query: string;
  namespace?: string;
  tiers?: MemoryTier[];
  limit?: number;
  include_working?: boolean;
}

export class MemoryService {
  private writeCount = 0;

  constructor(
    private store: MemoryStore,
    private cfg: UmgConfig,
    private consolidation?: ConsolidationService,
  ) {}

  setConsolidation(c: ConsolidationService): void {
    this.consolidation = c;
  }

  async retain(input: RetainInput): Promise<RetainResult> {
    const content = input.content?.trim() ?? "";
    if (!content) {
      return { action: "rejected", reason: "empty content" };
    }

    const maxChars = this.cfg.retain.max_content_chars;
    const body =
      content.length > maxChars
        ? truncate(content, maxChars)
        : content;

    const tier = this.cfg.retain.auto_tier
      ? autoTier(body, input.tier)
      : (input.tier ?? "episodic");

    if (isLowInformation(body) && tier !== "working") {
      await emitEvent(this.store, this.cfg, "reject", {
        reason: "low_information",
        preview: truncate(body, 80),
      });
      return { action: "rejected", reason: "low_information", tier };
    }

    const namespace = input.namespace ?? this.cfg.default_namespace;
    const now = nowIso();

    // Entity rarity context (namespace-scoped, capped scan)
    const nsCount = await this.store.count({
      namespace,
      status: "active",
    });
    const entityFreq = await this.store.entityFrequency(namespace, 2000);
    const importance = computeImportance(body, tier, input.importance, {
      namespaceEntityFreq: entityFreq,
      namespaceMemoryCount: Math.max(1, nsCount),
    });
    const minImp = this.cfg.retain.min_importance[tier];
    if (importance < minImp) {
      await emitEvent(this.store, this.cfg, "reject", {
        reason: "below_min_importance",
        importance,
        min: minImp,
        tier,
        preview: truncate(body, 80),
      });
      return {
        action: "rejected",
        reason: `importance ${importance.toFixed(2)} < min ${minImp} for ${tier}`,
        tier,
      };
    }

    // Merge / supersede / defer on write (additive-first policy — see contradiction.ts)
    let supersedesId: string | null = null;
    let deferredMeta: Record<string, unknown> | null = null;
    const entities = uniqueStrings([
      ...(input.entities ?? []),
      ...extractEntities(body),
    ]);

    if (!input.skip_merge) {
      // Hard isolation: never findSimilar across namespaces
      const similar = await this.store.findSimilar(body, {
        namespace,
        tiers: mergeCompatibleTiers(tier),
        limit: 5,
      });
      const best = similar[0];
      const threshold = this.cfg.consolidation.merge_threshold;

      if (best) {
        const decision = resolveWriteConflict(
          body,
          best.content,
          best.score,
          threshold,
          this.cfg.consolidation.supersede_min_confidence,
        );
        const mergeDecision = resolveMerge(
          body,
          best.content,
          best.score,
          decision,
          threshold,
          this.cfg.consolidation.merge_min_confidence,
        );

        // CLEAR contradiction only: archive prior, link lineage
        if (decision.action === "supersede") {
          supersedesId = best.id;
          await this.store.archive(best.id);
          await this.store.update(best.id, {
            metadata: {
              ...best.metadata,
              superseded_reason: decision.reason,
              superseded_at: now,
            },
          });
          await emitEvent(
            this.store,
            this.cfg,
            "archive",
            {
              reason: "superseded",
              contradiction: decision.reason,
              by_preview: truncate(body, 100),
              old_preview: truncate(best.content, 100),
            },
            best.id,
          );
        } else if (decision.action === "defer") {
          // AMBIGUOUS conflict: keep both; prune may resolve later
          deferredMeta = {
            conflict_deferred: true,
            related_memory_id: best.id,
            conflict_reason: decision.reason,
            topic_overlap: decision.topic_overlap,
          };
          await emitEvent(
            this.store,
            this.cfg,
            "retain",
            {
              reason: "conflict_deferred",
              related_id: best.id,
              contradiction: decision.reason,
              preview: truncate(body, 100),
            },
            best.id,
          );
        } else if (mergeDecision.action === "defer") {
          // Similar enough to look like a duplicate, not confident enough to
          // discard either one — different subjects, differing values, or both
          // sides carrying content the other lacks. Keep both, exactly as an
          // ambiguous conflict does.
          deferredMeta = {
            merge_deferred: true,
            related_memory_id: best.id,
            merge_reason: mergeDecision.reason,
            merge_detail: mergeDecision.detail,
            similarity: best.score,
          };
          await emitEvent(
            this.store,
            this.cfg,
            "retain",
            {
              reason: "merge_deferred",
              related_id: best.id,
              merge_reason: mergeDecision.reason,
              detail: mergeDecision.detail,
              preview: truncate(body, 100),
            },
            best.id,
          );
        } else if (mergeDecision.action === "merge") {
          // Near-duplicate, no contradiction → merge
          const merged = await this.mergeInto(best, {
            content: body,
            importance,
            tags: input.tags,
            entities,
            session_id: input.session_id,
            metadata: input.metadata,
            confidence: input.confidence,
            source: input.source,
          });
          await emitEvent(
            this.store,
            this.cfg,
            "merge",
            {
              into: merged.id,
              score: best.score,
              content_preview: truncate(body, 100),
              reason: "near_duplicate",
            },
            merged.id,
          );
          this.writeCount++;
          await this.maybeLightPrune();
          return {
            action: "merged",
            id: merged.id,
            tier: merged.tier,
            merged_into: merged.id,
            memory: merged,
          };
        }
      }
    }

    // Optional embedding (never blocks retain on failure)
    const embedding = await embedText(body, this.cfg);

    const memory: Memory = {
      id: newMemoryId(),
      tier,
      status: "active",
      content: body,
      summary: summarize(body),
      namespace,
      tags: uniqueStrings(input.tags ?? []),
      entities,
      source: input.source ?? "agent",
      session_id: input.session_id ?? null,
      importance,
      confidence: input.confidence ?? 0.7,
      access_count: 0,
      last_accessed_at: now,
      created_at: now,
      updated_at: now,
      expires_at: defaultExpiresAt(tier, now),
      decay_score: importance,
      embedding,
      metadata: {
        ...(input.metadata ?? {}),
        ...(supersedesId
          ? { supersede_reason: "contradiction", superseded_prior: supersedesId }
          : {}),
        ...(deferredMeta ?? {}),
      },
      parent_ids: supersedesId ? [supersedesId] : [],
      supersedes_id: supersedesId,
    };
    memory.decay_score = computeDecayScore(memory, this.cfg, now);

    await this.store.put(memory);
    await emitEvent(
      this.store,
      this.cfg,
      "retain",
      {
        action: supersedesId ? "superseded" : "created",
        tier,
        importance,
        namespace,
        preview: truncate(body, 100),
        supersedes_id: supersedesId,
      },
      memory.id,
    );
    log.debug("retained", {
      id: memory.id,
      tier,
      importance,
      supersedes: supersedesId,
    });

    this.writeCount++;
    await this.maybeLightPrune();

    if (supersedesId) {
      return {
        action: "superseded",
        id: memory.id,
        tier: memory.tier,
        superseded_id: supersedesId,
        reason: "contradiction_with_prior",
        memory,
      };
    }

    return { action: "created", id: memory.id, tier, memory };
  }

  private async mergeInto(
    target: Memory,
    incoming: {
      content: string;
      importance: number;
      tags?: string[];
      entities?: string[];
      session_id?: string;
      metadata?: Record<string, unknown>;
      confidence?: number;
      source?: string;
    },
  ): Promise<Memory> {
    // Prefer longer/richer content
    const content =
      incoming.content.length > target.content.length
        ? incoming.content
        : target.content;
    const tags = uniqueStrings([...(target.tags ?? []), ...(incoming.tags ?? [])]);
    const entities = uniqueStrings([
      ...(target.entities ?? []),
      ...(incoming.entities ?? []),
    ]);
    const importance = Math.max(target.importance, incoming.importance);
    const confidence = Math.min(
      1,
      Math.max(target.confidence, incoming.confidence ?? target.confidence) + 0.05,
    );
    const parent_ids = uniqueStrings([
      ...(target.parent_ids ?? []),
      target.id, // lineage marker if re-merged later still ok
    ]);
    const metadata = {
      ...target.metadata,
      ...(incoming.metadata ?? {}),
      merge_count: Number(target.metadata?.merge_count ?? 0) + 1,
    };
    const now = nowIso();
    return this.store.update(target.id, {
      content,
      summary: summarize(content),
      tags,
      entities,
      importance,
      confidence,
      parent_ids,
      metadata,
      session_id: incoming.session_id ?? target.session_id,
      source: incoming.source ?? target.source,
      updated_at: now,
      last_accessed_at: now,
      decay_score: computeDecayScore(
        { ...target, importance, last_accessed_at: now, access_count: target.access_count + 1 },
        this.cfg,
        now,
      ),
      access_count: target.access_count + 1,
    });
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const limit = Math.min(
      input.limit ?? this.cfg.recall.default_limit,
      this.cfg.recall.max_limit,
    );
    // Hard isolation: default to configured namespace when not provided
    const namespace = this.cfg.namespace.hard_isolation
      ? (input.namespace ?? this.cfg.default_namespace)
      : input.namespace;
    const includeWorking = input.include_working ?? true;

    let tiers = input.tiers;
    if (!tiers && !includeWorking) {
      tiers = ["episodic", "semantic", "procedural"];
    }

    const raw = await this.store.search({
      text: input.query,
      namespace,
      tiers,
      limit: limit * 2,
      include_working: includeWorking,
      status: "active",
    });

    const now = nowIso();
    const queryEmbedding = this.cfg.embeddings.enabled
      ? await embedText(input.query, this.cfg)
      : null;
    const ranked = rankForRecall(
      raw,
      this.cfg,
      now,
      input.query,
      queryEmbedding,
    ).slice(0, limit);

    // Touch access + session boost timestamp
    for (const m of ranked) {
      try {
        const meta = {
          ...m.metadata,
          last_recalled_at: now,
        };
        await this.store.update(m.id, {
          access_count: m.access_count + 1,
          last_accessed_at: now,
          metadata: meta,
          decay_score: computeDecayScore(
            {
              ...m,
              access_count: m.access_count + 1,
              last_accessed_at: now,
              metadata: meta,
            },
            this.cfg,
            now,
          ),
        });
      } catch {
        // ignore touch failures
      }
    }

    const topScore = ranked[0]?.score ?? 0;
    const avgDecay =
      ranked.length > 0
        ? ranked.reduce((s, m) => s + m.decay_score, 0) / ranked.length
        : 0;

    await emitEvent(this.store, this.cfg, "recall", {
      query: truncate(input.query, 120),
      count: ranked.length,
      ids: ranked.map((m) => m.id),
      top_score: topScore,
      high_value: topScore >= 0.4,
      avg_decay: avgDecay,
    });

    return {
      memories: ranked as ScoredMemory[],
      query: input.query,
      count: ranked.length,
    };
  }

  async list(filter: ListFilter = {}): Promise<Memory[]> {
    return this.store.list({
      status: "active",
      limit: 50,
      order_by: "updated_at",
      order_dir: "desc",
      ...filter,
    });
  }

  async get(id: string): Promise<Memory | null> {
    return this.store.get(id);
  }

  private async maybeLightPrune(): Promise<void> {
    const every = this.cfg.consolidation.light_prune_every_n_writes;
    if (!this.consolidation || every <= 0) return;
    if (this.writeCount % every !== 0) return;
    try {
      await this.consolidation.prune({ light: true });
    } catch (err) {
      log.warn("light prune failed", { error: String(err) });
    }
  }
}

function mergeCompatibleTiers(tier: MemoryTier): MemoryTier[] {
  switch (tier) {
    case "working":
      return ["working", "episodic"];
    case "episodic":
      return ["episodic", "semantic", "working"];
    case "semantic":
      return ["semantic", "episodic"];
    case "procedural":
      return ["procedural", "semantic"];
    default:
      return [tier];
  }
}
