import type { UmgConfig } from "../config.js";
import type { MemoryStore } from "../store/interface.js";
import type { MemoryService } from "./memory.js";
import type { Memory, PromoteResult } from "../types.js";
import { emitEvent } from "../observability/events.js";
import { summarize, uniqueStrings } from "../util/text.js";
import { log } from "../util/log.js";

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

    log.info("promoted to skill", { id: result.memory.id, sources: sources.length });

    return {
      id: result.memory.id,
      memory: result.memory,
      source_ids: sources.map((s) => s.id),
      archived_sources,
    };
  }

  /**
   * Auto-promote: entity/tag clusters with enough access across sessions.
   * Deterministic and conservative.
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

    // Group by primary entity or first tag
    const groups = new Map<string, Memory[]>();
    for (const m of candidates) {
      if (m.access_count < minRecalls) continue;
      const key =
        m.entities[0]?.toLowerCase() ||
        m.tags.find((t) => t !== "skill")?.toLowerCase() ||
        null;
      if (!key) continue;
      const list = groups.get(key) ?? [];
      list.push(m);
      groups.set(key, list);
    }

    const results: PromoteResult[] = [];
    for (const [key, mems] of groups) {
      const sessions = new Set(
        mems.map((m) => m.session_id).filter(Boolean) as string[],
      );
      // If no session_ids, require enough members instead
      const sessionOk =
        sessions.size >= minSessions ||
        (sessions.size === 0 && mems.length >= minSessions);
      const recallOk = mems.reduce((a, m) => a + m.access_count, 0) >= minRecalls;
      if (!sessionOk || !recallOk) continue;

      // Skip if procedural skill already exists for this key
      const existing = await this.store.search({
        text: key,
        namespace: mems[0].namespace,
        tiers: ["procedural"],
        limit: 3,
      });
      if (existing.some((e) => e.content.toLowerCase().includes(key))) {
        continue;
      }

      try {
        const promo = await this.promoteToSkill({
          memory_ids: mems.slice(0, 5).map((m) => m.id),
          title: `Skill: ${key}`,
          tags: [key, "auto-promoted"],
          namespace: mems[0].namespace,
        });
        results.push(promo);
      } catch (err) {
        log.warn("auto-promote group failed", { key, error: String(err) });
      }
    }

    return results;
  }
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
