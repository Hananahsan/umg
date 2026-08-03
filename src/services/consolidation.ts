import type { UmgConfig } from "../config.js";
import type { MemoryStore } from "../store/interface.js";
import type { Memory, MemoryTier, PruneResult } from "../types.js";
import { MEMORY_TIERS } from "../types.js";
import { computeDecayScore } from "./scoring.js";
import { resolveWriteConflict } from "./contradiction.js";
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
    let proposed_skills: Array<Record<string, unknown>> | undefined;

    const floor = aggressive
      ? this.cfg.consolidation.eviction_floor * 1.5
      : this.cfg.consolidation.eviction_floor;
    const mergeThreshold = aggressive
      ? Math.max(0.7, this.cfg.consolidation.merge_threshold - 0.05)
      : this.cfg.consolidation.merge_threshold;
    const maxPasses = Math.max(
      1,
      this.cfg.consolidation.merge_max_passes ?? 3,
    );

    // Load active memories (bounded)
    let memories = await this.store.list({
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
        details.push({
          action: "decay",
          reason: "recompute",
          id: m.id,
          from: m.decay_score,
          to: ds,
        });
        if (!dry) {
          await this.store.update(m.id, { decay_score: ds, updated_at: now });
        }
        // Applied on dry runs too: the score-floor and cap steps below must
        // see the recomputed value, or a dry run predicts a different
        // outcome than the real one it is previewing.
        m.decay_score = ds;
      }
    }

    // Archived during this run. findSimilar reads the database, which on a
    // dry run still reports these as active — without this set the same
    // merge/supersede is re-detected on every pass and the counts inflate.
    const consumed = new Set<string>();

    // 2) Hard expiry
    for (const m of memories) {
      if (m.expires_at && m.expires_at < now) {
        archived++;
        details.push({
          action: "expire",
          reason: "expired",
          id: m.id,
          expires_at: m.expires_at,
        });
        if (!dry) await this.store.archive(m.id);
        m.status = "archived";
        consumed.add(m.id);
      }
    }

    if (!light) {
      // 3) Bounded multi-pass merge / clear-supersede
      const byId = new Map(memories.map((m) => [m.id, m]));

      for (let pass = 1; pass <= maxPasses; pass++) {
        const active = memories.filter((m) => m.status === "active");
        let changesThisPass = 0;
        const mergeSeen = new Set<string>();

        for (const m of active) {
          if (mergeSeen.has(m.id) || consumed.has(m.id) || m.status !== "active") {
            continue;
          }
          const similar = await this.store.findSimilar(m.content, {
            namespace: m.namespace,
            limit: 5,
            exclude_id: m.id,
          });
          for (const candidate of similar) {
            // Prefer the tracked instance so status/content changes made
            // earlier in this run are visible to later passes.
            const s: Memory = byId.get(candidate.id) ?? candidate;
            const similarity = candidate.score;
            if (mergeSeen.has(s.id) || consumed.has(s.id) || s.status !== "active") {
              continue;
            }

            const decision = resolveWriteConflict(
              m.content,
              s.content,
              similarity,
              mergeThreshold,
              this.cfg.consolidation.supersede_min_confidence,
            );

            // CLEAR contradiction only (defer on write; prune may still supersede when clear)
            if (decision.action === "supersede") {
              const winner = pickMergeTarget(m, s);
              const loser = winner.id === m.id ? s : m;
              details.push({
                action: "supersede",
                reason: "contradiction",
                conflict: decision.reason,
                into: winner.id,
                from: loser.id,
                score: similarity,
                pass,
              });
              mergeSeen.add(loser.id);
              consumed.add(loser.id);
              archived++;
              changesThisPass++;
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
              }
              loser.status = "archived";
              break;
            }

            if (similarity < mergeThreshold) continue;
            const target = pickMergeTarget(m, s);
            const source = target.id === m.id ? s : m;
            if (target.id === source.id) continue;

            details.push({
              action: "merge",
              reason: "near_duplicate",
              into: target.id,
              from: source.id,
              score: similarity,
              pass,
            });
            merged++;
            changesThisPass++;
            mergeSeen.add(source.id);
            consumed.add(source.id);

            if (!dry) {
              await this.applyMerge(target, source);
              await this.store.archive(source.id);
            }
            source.status = "archived";
            // Keep target content updated in local list for later passes
            if (target.content.length < source.content.length) {
              target.content = source.content;
            }
            target.entities = uniqueStrings([
              ...target.entities,
              ...source.entities,
            ]);
            target.tags = uniqueStrings([...target.tags, ...source.tags]);
            break;
          }
        }

        if (changesThisPass === 0) break;

        // Refresh from store after each pass for correctness (dry uses in-memory status)
        if (!dry) {
          memories = await this.store.list({
            namespace: opts.namespace,
            status: "active",
            limit: 5000,
            order_by: "updated_at",
            order_dir: "desc",
          });
          byId.clear();
          for (const m of memories) byId.set(m.id, m);
        } else {
          memories = memories.filter((m) => m.status === "active");
        }
      }

      const stillActive = memories.filter((m) => m.status === "active");

      // 4) Score-floor eviction (with grace period)
      // Policy: never score-floor procedural when evict_procedural is false
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
            reason: "score_floor",
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
      if (this.cfg.consolidation.auto_promote && this.promotion) {
        try {
          const promoteDry =
            dry || this.cfg.consolidation.promote_dry_run_proposed;
          const promo = await this.promotion.autoPromote(opts.namespace, {
            dry_run: promoteDry,
          });
          if (promoteDry) {
            proposed_skills = promo.map((p) => ({
              dry_run: true,
              rejected: p.rejected,
              rejected_reason: p.rejected_reason,
              title: p.memory?.content?.slice(0, 80),
              source_ids: p.source_ids,
              id: p.id,
            }));
            for (const p of promo) {
              details.push({
                action: "propose_skill",
                reason: p.rejected ? "rejected" : "dry_run",
                rejected_reason: p.rejected_reason,
                sources: p.source_ids,
              });
            }
          } else {
            promoted = promo.filter((p) => !p.rejected && p.id).length;
            for (const p of promo) {
              details.push({
                action: p.rejected ? "promote_reject" : "promote",
                reason: p.rejected_reason ?? "auto_promote",
                id: p.id,
                sources: p.source_ids,
              });
            }
          }
        } catch (err) {
          log.warn("auto-promote failed", { error: String(err) });
        }
      }

      // 7) Purge old archives
      if (!dry) {
        const cutoff = addDaysIso(
          now,
          -this.cfg.consolidation.archive_retention_days,
        );
        purged = await this.store.purgeArchivedOlderThan(cutoff);
        if (purged > 0) {
          details.push({
            action: "purge_archives",
            reason: "archive_retention",
            count: purged,
            cutoff,
          });
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
      proposed_skills,
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
      source.content.length > target.content.length
        ? source.content
        : target.content;
    const now = nowIso();
    return this.store.update(target.id, {
      content,
      summary: content.slice(0, 160),
      tags: uniqueStrings([...target.tags, ...source.tags]),
      entities: uniqueStrings([...target.entities, ...source.entities]),
      importance: Math.max(target.importance, source.importance),
      confidence: Math.min(
        1,
        Math.max(target.confidence, source.confidence) + 0.05,
      ),
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
          metadata: target.metadata ?? {},
        },
        this.cfg,
        now,
      ),
    });
  }

  /**
   * Cap enforcement policy:
   * - Non-procedural: archive lowest decay until under tier cap.
   * - Procedural when evict_procedural=false: never archive for tier/global cap;
   *   emit cap_skip_procedural if over tier cap.
   * - Global cap never takes procedural when flag is false.
   */
  private async enforceCaps(
    active: Memory[],
    dry: boolean,
    details: Array<Record<string, unknown>>,
  ): Promise<{ archived: number }> {
    let archived = 0;
    const caps = this.cfg.consolidation.caps;
    const allowProc = this.cfg.consolidation.evict_procedural;

    for (const tier of MEMORY_TIERS) {
      const list = active
        .filter((m) => m.tier === tier && m.status === "active")
        .sort(evictionOrder);
      const cap = caps[tier];

      if (tier === "procedural" && !allowProc) {
        if (list.length > cap) {
          details.push({
            action: "cap_skip_procedural",
            reason: "cap_tier_protected",
            tier,
            count: list.length,
            cap,
          });
        }
        continue;
      }

      while (list.length > cap) {
        const victim = list.pop()!;
        details.push({
          action: "evict_cap",
          reason: "cap_tier",
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

    // Global cap — exclude procedural unless explicitly allowed
    const globalActive = active
      .filter((m) => m.status === "active")
      .filter((m) => m.tier !== "procedural" || allowProc)
      .sort(evictionOrder);
    while (globalActive.length > caps.global) {
      const victim = globalActive.pop()!;
      details.push({
        action: "evict_global",
        reason: "cap_global",
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
