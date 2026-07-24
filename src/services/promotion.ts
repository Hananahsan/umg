import type { UmgConfig } from "../config.js";
import type { MemoryStore } from "../store/interface.js";
import type { MemoryService } from "./memory.js";
import type { Memory, PromoteResult } from "../types.js";
import { emitEvent } from "../observability/events.js";
import {
  setIntersectionSize,
  setJaccard,
} from "../util/entities.js";
import { summarize, uniqueStrings } from "../util/text.js";
import { log } from "../util/log.js";

const SKIP_TAGS = new Set(["skill", "auto-promoted", "procedural"]);

export class PromotionService {
  constructor(
    private store: MemoryStore,
    private cfg: UmgConfig,
    private memory: MemoryService,
  ) {}

  async promoteToSkill(input: {
    memory_ids: string[];
    title?: string;
    content?: string;
    tags?: string[];
    namespace?: string;
  }): Promise<PromoteResult> {
    const sources: Memory[] = [];
    for (const id of input.memory_ids) {
      const m = await this.store.get(id);
      if (m && m.status === "active") sources.push(m);
    }
    if (sources.length === 0 && !input.content) {
      throw new Error("No valid source memories and no content provided");
    }

    const namespace =
      input.namespace ?? sources[0]?.namespace ?? this.cfg.default_namespace;
    const title =
      input.title ??
      (sources[0] ? summarize(sources[0].content, 80) : "Skill");
    const body =
      input.content ??
      formatSkillBody(
        title,
        sources.map((s) => s.content),
      );
    const tags = uniqueStrings([
      "skill",
      "procedural",
      ...(input.tags ?? []),
      ...sources.flatMap((s) => s.tags),
    ]);
    const entities = uniqueStrings(sources.flatMap((s) => s.entities));

    const result = await this.memory.retain({
      content: body,
      tier: "procedural",
      namespace,
      importance: 0.9,
      tags,
      entities,
      source: "promote",
      metadata: {
        skill_title: title,
        promoted_from: sources.map((s) => s.id),
      },
      skip_merge: false,
    });

    if (result.action === "rejected" || !result.memory) {
      throw new Error(result.reason ?? "Failed to create procedural memory");
    }

    const archived_sources: string[] = [];
    if (this.cfg.consolidation.archive_sources_on_promote) {
      for (const s of sources) {
        if (s.tier === "episodic") {
          await this.store.archive(s.id);
          archived_sources.push(s.id);
        }
      }
    }

    await emitEvent(
      this.store,
      this.cfg,
      "promote",
      {
        skill_id: result.memory.id,
        sources: sources.map((s) => s.id),
        archived: archived_sources,
      },
      result.memory.id,
    );

    log.info("promoted to skill", {
      id: result.memory.id,
      sources: sources.length,
    });

    return {
      id: result.memory.id,
      memory: result.memory,
      source_ids: sources.map((s) => s.id),
      archived_sources,
    };
  }

  /**
   * Auto-promote via entity/tag set clustering (conservative).
   * Requires ≥2 members in a cluster — no single-memory auto skills.
   */
  async autoPromote(namespace?: string): Promise<PromoteResult[]> {
    const minRecalls = this.cfg.consolidation.promote_min_recalls;
    const minSessions = this.cfg.consolidation.promote_min_sessions;

    const candidates = await this.store.list({
      namespace,
      status: "active",
      tiers: ["episodic", "semantic"],
      limit: 500,
      order_by: "importance",
      order_dir: "desc",
    });

    const eligible = candidates.filter((m) => {
      if (m.access_count < 1) return false;
      if (m.tier === "semantic" && m.importance < 0.5) return false;
      if (m.tier === "episodic" && m.importance < 0.45) return false;
      const ents = cleanEntities(m);
      const tags = cleanTags(m);
      return ents.length > 0 || tags.length > 0;
    });

    const clusters = clusterMemories(eligible);
    const results: PromoteResult[] = [];

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;

      const totalAccess = cluster.reduce((a, m) => a + m.access_count, 0);
      if (totalAccess < minRecalls) continue;

      const sessions = new Set(
        cluster.map((m) => m.session_id).filter(Boolean) as string[],
      );
      const sessionOk =
        sessions.size >= minSessions ||
        (sessions.size === 0 && cluster.length >= minSessions);
      if (!sessionOk) continue;

      const label = clusterLabel(cluster);
      if (!label) continue;

      const existing = await this.store.search({
        text: label,
        namespace: cluster[0].namespace,
        tiers: ["procedural"],
        limit: 3,
      });
      if (existing.some((e) => e.content.toLowerCase().includes(label))) {
        continue;
      }

      // Prefer highest-access members
      const ranked = [...cluster].sort(
        (a, b) => b.access_count - a.access_count || b.importance - a.importance,
      );

      try {
        const promo = await this.promoteToSkill({
          memory_ids: ranked.slice(0, 5).map((m) => m.id),
          title: `Skill: ${label}`,
          tags: [label, "auto-promoted"],
          namespace: cluster[0].namespace,
        });
        results.push(promo);
      } catch (err) {
        log.warn("auto-promote group failed", { label, error: String(err) });
      }
    }

    return results;
  }
}

function cleanEntities(m: Memory): string[] {
  return uniqueStrings(m.entities.map((e) => e.trim()).filter(Boolean));
}

function cleanTags(m: Memory): string[] {
  return uniqueStrings(
    m.tags
      .map((t) => t.trim())
      .filter((t) => t && !SKIP_TAGS.has(t.toLowerCase())),
  );
}

/**
 * Greedy clustering: attach to first compatible cluster, else new cluster.
 * Compatible if entity Jaccard ≥ 0.5, or |entity ∩| ≥ 2, or
 * (tag Jaccard ≥ 0.5 and ≥1 shared entity).
 */
export function clusterMemories(memories: Memory[]): Memory[][] {
  const clusters: Memory[][] = [];

  for (const m of memories) {
    let placed = false;
    for (const c of clusters) {
      if (c.some((other) => memoriesRelated(m, other))) {
        c.push(m);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([m]);
  }

  return clusters;
}

export function memoriesRelated(a: Memory, b: Memory): boolean {
  const ea = cleanEntities(a);
  const eb = cleanEntities(b);
  const ta = cleanTags(a);
  const tb = cleanTags(b);

  if (setJaccard(ea, eb) >= 0.5) return true;
  if (setIntersectionSize(ea, eb) >= 2) return true;
  if (setJaccard(ta, tb) >= 0.5 && setIntersectionSize(ea, eb) >= 1) {
    return true;
  }
  return false;
}

function clusterLabel(cluster: Memory[]): string | null {
  const counts = new Map<string, number>();
  for (const m of cluster) {
    for (const e of cleanEntities(m)) {
      const k = e.toLowerCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  if (counts.size === 0) {
    for (const m of cluster) {
      for (const t of cleanTags(m)) {
        const k = t.toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function formatSkillBody(title: string, sources: string[]): string {
  const lessons = sources.map((s, i) => `${i + 1}. ${s.trim()}`).join("\n");
  return [
    `Skill: ${title}`,
    `When to use: When related context matches this skill topic.`,
    `Lessons:`,
    lessons || "(none)",
  ].join("\n");
}
