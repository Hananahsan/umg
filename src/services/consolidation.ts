import type { UmgConfig } from "../config.js";
import type { MemoryStore } from "../store/interface.js";
import type { Memory, MemoryTier, PruneResult } from "../types.js";
import { MEMORY_TIERS } from "../types.js";
import { computeDecayScore } from "./scoring.js";
import { shouldSupersede } from "./contradiction.js";
import { emitEvent } from "../observability/events.js";
import { log } from "../util/log.js";
import { addDaysIso, nowIso, truncate, uniqueStrings } from "../util/text.js";
import type { PromotionService } from "./promotion.js";

export interface PruneOptions {
  dry_run?: boolean;
  namespace?: string;
  aggressive?: boolean;
  /** Light prune: decay + expiry only, no merge/cap eviction. */
  light?: boolean;
}

export class ConsolidationService {
  private promotion?: PromotionService;

  constructor(
    private store: MemoryStore,
    private cfg: UmgConfig,
  ) {}

  setPromotion(p: PromotionService): void {
    this.promotion = p;
  }

  async prune(opts: PruneOptions = {}): Promise<PruneResult> {
    const dry = opts.dry_run ?? false;
    const light = opts.light ?? false;
    const aggressive = opts.aggressive ?? false;
    const now = nowIso();
    const details: Array<Record<string, unknown>> = [];
    let decayed = 0;
    let merged = 0;
    let archived = 0;
    let purged = 0;
    let promoted = 0;

    const floor = aggressive
      ? this.cfg.consolidation.eviction_floor * 1.5
      : this.cfg.consolidation.eviction_floor;
    const mergeThreshold = aggressive
      ? Math.max(0.7, this.cfg.consolidation.merge_threshold - 0.05)
      : this.cfg.consolidation.merge_threshold;

    // Load active memories (bounded)
    const memories = await this.store.list({
      namespace: opts.namespace,
      status: "active",
      limit: 5000,
      order_by: "updated_at",
      order_dir: "desc",
    });

    // 1) Recompute decay
    for (const m of memories) {
      const ds = computeDecayScore(m, this.cfg, now);
      if (Math.abs(ds - m.decay_score) > 0.001) {
        decayed++;
        details.push({ action: "decay", id: m.id, from: m.decay_score, to: ds });
        if (!dry) {
          await this.store.update(m.id, { decay_score: ds, updated_at: now });
          m.decay_score = ds;
        }
      }
    }

    // 2) Hard expiry
    for (const m of memories) {
      if (m.expires_at && m.expires_at < now) {
        archived++;
        details.push({ action: "expire", id: m.id, expires_at: m.expires_at });
        if (!dry) await this.store.archive(m.id);
        m.status = "archived";
      }
    }

    const active = memories.filter((m) => m.status === "active");

    if (!light) {
      // 3) Merge pass (newest first)
      const mergeSeen = new Set<string>();
      for (const m of active) {
        if (mergeSeen.has(m.id) || m.status !== "active") continue;
        const similar = await this.store.findSimilar(m.content, {
          namespace: m.namespace,
          limit: 5,
          exclude_id: m.id,
        });
        for (const s of similar) {
          if (mergeSeen.has(s.id)) continue;

          const decision = shouldSupersede(
            m.content,
            s.content,
            s.score,
            mergeThreshold,
          );

          // Contradiction: keep newer/higher-importance, archive loser with supersedes link
          if (decision.supersede) {
            const winner = pickMergeTarget(m, s);
            const loser = winner.id === m.id ? s : m;
            details.push({
              action: "supersede",
              into: winner.id,
              from: loser.id,
              reason: decision.reason,
              score: s.score,
            });
            mergeSeen.add(loser.id);
            archived++;
            if (!dry) {
              await this.store.update(winner.id, {
                supersedes_id: loser.id,
                parent_ids: uniqueStrings([
                  ...(winner.parent_ids ?? []),
                  loser.id,
                ]),
                metadata: {
                  ...winner.metadata,
                  supersede_reason: decision.reason,
                },
                updated_at: now,
              });
              await this.store.archive(loser.id);
              loser.status = "archived";
            }
            break;
          }

          if (s.score < mergeThreshold) continue;
          // Keep higher importance / newer as target
          const target = pickMergeTarget(m, s);
          const source = target.id === m.id ? s : m;
          if (target.id === source.id) continue;

          details.push({
            action: "merge",
            into: target.id,
            from: source.id,
            score: s.score,
          });
          merged++;
          mergeSeen.add(source.id);

          if (!dry) {
            await this.applyMerge(target, source);
            await this.store.archive(source.id);
            source.status = "archived";
            archived++;
          }
          break; // one merge per source pass
        }
      }

      // Refresh active list conceptually
      const stillActive = active.filter((m) => m.status === "active");

      // 4) Score-floor eviction (with grace period)
      const graceDays = this.cfg.consolidation.grace_period_days;
      for (const m of stillActive) {
        if (m.tier === "procedural" && !this.cfg.consolidation.evict_procedural) {
          continue;
        }
        const ageDays =
          (Date.parse(now) - Date.parse(m.created_at)) / (1000 * 60 * 60 * 24);
        if (m.decay_score < floor && ageDays >= graceDays) {
          details.push({
            action: "evict_floor",
            id: m.id,
            decay_score: m.decay_score,
            floor,
          });
          archived++;
          m.status = "archived";
          if (!dry) await this.store.archive(m.id);
        }
      }

      // 5) Cap pressure
      const capResult = await this.enforceCaps(
        stillActive.filter((m) => m.status === "active"),
        dry,
        details,
      );
      archived += capResult.archived;

      // 6) Auto-promote (optional)
      if (this.cfg.consolidation.auto_promote && this.promotion && !dry) {
        try {
          const promo = await this.promotion.autoPromote(opts.namespace);
          promoted = promo.length;
          for (const p of promo) {
            details.push({ action: "promote", id: p.id, sources: p.source_ids });
          }
        } catch (err) {
          log.warn("auto-promote failed", { error: String(err) });
        }
      }

      // 7) Purge old archives
      if (!dry) {
        const cutoff = addDaysIso(now, -this.cfg.consolidation.archive_retention_days);
        purged = await this.store.purgeArchivedOlderThan(cutoff);
        if (purged > 0) {
          details.push({ action: "purge_archives", count: purged, cutoff });
        }
      }
    }

    const result: PruneResult = {
      dry_run: dry,
      decayed,
      merged,
      archived,
      purged,
      promoted,
      details: details.slice(0, 100),
    };

    if (!dry) {
      this.store.setMeta("last_prune_at", now);
      this.store.setMeta(
        "last_prune_summary",
        JSON.stringify({
          light,
          decayed,
          merged,
          archived,
          purged,
          promoted,
          at: now,
        }),
      );
    }

    await emitEvent(this.store, this.cfg, "prune", {
      ...result,
      details: result.details.length,
      light,
      aggressive,
      namespace: opts.namespace ?? null,
    });

    log.info("prune complete", {
      dry,
      light,
      decayed,
      merged,
      archived,
      purged,
      promoted,
    });

    return result;
  }

  private async applyMerge(target: Memory, source: Memory): Promise<Memory> {
    const content =
      source.content.length > target.content.length ? source.content : target.content;
    const now = nowIso();
    return this.store.update(target.id, {
      content,
      summary: content.slice(0, 160),
      tags: uniqueStrings([...target.tags, ...source.tags]),
      entities: uniqueStrings([...target.entities, ...source.entities]),
      importance: Math.max(target.importance, source.importance),
      confidence: Math.min(1, Math.max(target.confidence, source.confidence) + 0.05),
      parent_ids: uniqueStrings([...target.parent_ids, source.id]),
      access_count: target.access_count + source.access_count,
      last_accessed_at: now,
      updated_at: now,
      metadata: {
        ...target.metadata,
        ...source.metadata,
        merge_count:
          Number(target.metadata?.merge_count ?? 0) +
          Number(source.metadata?.merge_count ?? 0) +
          1,
      },
      decay_score: computeDecayScore(
        {
          tier: target.tier,
          importance: Math.max(target.importance, source.importance),
          access_count: target.access_count + source.access_count,
          last_accessed_at: now,
        },
        this.cfg,
        now,
      ),
    });
  }

  private async enforceCaps(
    active: Memory[],
    dry: boolean,
    details: Array<Record<string, unknown>>,
  ): Promise<{ archived: number }> {
    let archived = 0;
    const caps = this.cfg.consolidation.caps;

    // Per-tier caps
    for (const tier of MEMORY_TIERS) {
      if (tier === "procedural" && !this.cfg.consolidation.evict_procedural) {
        // Still enforce procedural cap only if over hard limit * 1.5
        const list = active
          .filter((m) => m.tier === tier && m.status === "active")
          .sort(evictionOrder);
        const cap = caps[tier];
        while (list.length > cap) {
          const victim = list.pop()!;
          if (victim.tier === "procedural" && list.length <= cap * 1.5) break;
          details.push({
            action: "evict_cap",
            tier,
            id: victim.id,
            decay_score: victim.decay_score,
            preview: truncate(victim.content, 60),
          });
          victim.status = "archived";
          archived++;
          if (!dry) await this.store.archive(victim.id);
        }
        continue;
      }

      const list = active
        .filter((m) => m.tier === tier && m.status === "active")
        .sort(evictionOrder);
      const cap = caps[tier];
      while (list.length > cap) {
        const victim = list.pop()!;
        details.push({
          action: "evict_cap",
          tier,
          id: victim.id,
          decay_score: victim.decay_score,
          preview: truncate(victim.content, 60),
        });
        victim.status = "archived";
        archived++;
        if (!dry) await this.store.archive(victim.id);
      }
    }

    // Global cap
    const globalActive = active
      .filter((m) => m.status === "active")
      .filter(
        (m) =>
          m.tier !== "procedural" || this.cfg.consolidation.evict_procedural,
      )
      .sort(evictionOrder);
    while (globalActive.length > caps.global) {
      const victim = globalActive.pop()!;
      details.push({
        action: "evict_global",
        id: victim.id,
        tier: victim.tier,
        decay_score: victim.decay_score,
      });
      victim.status = "archived";
      archived++;
      if (!dry) await this.store.archive(victim.id);
    }

    return { archived };
  }
}

function pickMergeTarget(a: Memory, b: Memory): Memory {
  if (a.importance !== b.importance) {
    return a.importance >= b.importance ? a : b;
  }
  return a.updated_at >= b.updated_at ? a : b;
}

/** Ascending decay then oldest access — last elements are eviction victims. */
function evictionOrder(a: Memory, b: Memory): number {
  if (a.decay_score !== b.decay_score) return a.decay_score - b.decay_score;
  return a.last_accessed_at.localeCompare(b.last_accessed_at);
}

export type { MemoryTier };
