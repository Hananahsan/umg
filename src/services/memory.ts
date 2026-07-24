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
import { emitEvent } from "../observability/events.js";
import { log } from "../util/log.js";
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

    const importance = computeImportance(body, tier, input.importance);
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

    const namespace = input.namespace ?? this.cfg.default_namespace;
    const now = nowIso();

    // Merge-on-write
    if (!input.skip_merge) {
      const similar = await this.store.findSimilar(body, {
        namespace,
        tiers: mergeCompatibleTiers(tier),
        limit: 5,
      });
      const best = similar[0];
      const threshold = this.cfg.consolidation.merge_threshold;
      if (best && best.score >= threshold) {
        const merged = await this.mergeInto(best, {
          content: body,
          importance,
          tags: input.tags,
          entities: input.entities,
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

    const memory: Memory = {
      id: newMemoryId(),
      tier,
      status: "active",
      content: body,
      summary: summarize(body),
      namespace,
      tags: uniqueStrings(input.tags ?? []),
      entities: uniqueStrings(input.entities ?? []),
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
      embedding: null,
      metadata: input.metadata ?? {},
      parent_ids: [],
      supersedes_id: null,
    };
    memory.decay_score = computeDecayScore(memory, this.cfg, now);

    await this.store.put(memory);
    await emitEvent(
      this.store,
      this.cfg,
      "retain",
      { tier, importance, namespace, preview: truncate(body, 100) },
      memory.id,
    );
    log.debug("retained", { id: memory.id, tier, importance });

    this.writeCount++;
    await this.maybeLightPrune();

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
    const namespace = input.namespace; // undefined = search all unless we force default
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

    const ranked = rankForRecall(raw, this.cfg).slice(0, limit);

    // Touch access (best-effort, rate-limited by store update)
    const now = nowIso();
    for (const m of ranked) {
      try {
        await this.store.update(m.id, {
          access_count: m.access_count + 1,
          last_accessed_at: now,
          decay_score: computeDecayScore(
            { ...m, access_count: m.access_count + 1, last_accessed_at: now },
            this.cfg,
            now,
          ),
        });
      } catch {
        // ignore touch failures
      }
    }

    await emitEvent(this.store, this.cfg, "recall", {
      query: truncate(input.query, 120),
      count: ranked.length,
      ids: ranked.map((m) => m.id),
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
