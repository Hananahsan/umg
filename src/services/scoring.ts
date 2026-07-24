import type { UmgConfig } from "../config.js";
import type { Memory, MemoryTier, ScoredMemory } from "../types.js";
import { entityOverlapScore, extractEntities } from "../util/entities.js";
import { cosineSimilarity } from "../util/embeddings.js";
import { clamp, daysBetween, nowIso, tokenize } from "../util/text.js";

const TIER_PRIOR: Record<MemoryTier, number> = {
  working: 0.25,
  episodic: 0.45,
  semantic: 0.7,
  procedural: 0.85,
};

const RECALL_TIER_PRIOR: Record<MemoryTier, number> = {
  working: 0.5,
  episodic: 0.7,
  semantic: 0.9,
  procedural: 1.0,
};

const REMEMBER_RE =
  /\b(remember|always|prefer|preference|decision:|note that|for the record|never forget)\b/i;
const CORRECTION_RE = /\b(don't|do not|never|actually|instead|not\s+\w+\s+but)\b/i;
const GREETING_RE =
  /^(hi|hello|hey|thanks|thank you|ok|okay|sure|yes|no|cool|great)[\s!.]*$/i;

export interface ImportanceContext {
  /** entity lower → number of active memories in namespace that contain it */
  namespaceEntityFreq?: Map<string, number>;
  namespaceMemoryCount?: number;
}

/** Compute importance at write time (pure heuristic, offline). */
export function computeImportance(
  content: string,
  tier: MemoryTier,
  supplied?: number,
  ctx?: ImportanceContext,
): number {
  let score = TIER_PRIOR[tier];

  if (REMEMBER_RE.test(content)) score += 0.2;
  if (CORRECTION_RE.test(content)) score += 0.15;

  const tokens = tokenize(content);
  const entities = extractEntities(content);
  const entityLike = tokens.filter(
    (t) => /[0-9_/.-]/.test(t) || /^[A-Z]{2,}$/.test(t),
  );
  if (tokens.length > 0 && tokens.length <= 40 && entityLike.length >= 1) {
    score += 0.1;
  }

  // Entity density: short facts with many unique entities
  if (tokens.length > 0 && tokens.length <= 40 && entities.length > 0) {
    const density = entities.length / tokens.length;
    if (density >= 0.15) score += 0.08;
  }

  // Entity rarity within namespace
  if (
    ctx?.namespaceEntityFreq &&
    ctx.namespaceMemoryCount &&
    ctx.namespaceMemoryCount > 0 &&
    entities.length > 0
  ) {
    let rarityBoost = 0;
    for (const e of entities) {
      const key = e.toLowerCase();
      const freq = ctx.namespaceEntityFreq.get(key) ?? 0;
      const ratio = freq / ctx.namespaceMemoryCount;
      if (ratio <= 0.15) {
        // rarer → higher boost, 0.05–0.12
        const r = 1 - ratio / 0.15;
        rarityBoost = Math.max(rarityBoost, 0.05 + 0.07 * r);
      }
    }
    score += Math.min(0.12, rarityBoost);
  }

  if (content.length > 2000) score -= 0.1;
  if (GREETING_RE.test(content.trim())) score -= 0.4;
  if (tokens.length < 3 && !REMEMBER_RE.test(content)) score -= 0.15;

  score = clamp(score);

  if (supplied !== undefined && !Number.isNaN(supplied)) {
    score = clamp(0.7 * clamp(supplied) + 0.3 * score);
  }
  return score;
}

export function autoTier(content: string, explicit?: MemoryTier): MemoryTier {
  if (explicit) return explicit;
  const c = content.toLowerCase();

  if (
    /\b(how to|steps?:|procedure|playbook|skill:|workflow|runbook)\b/i.test(
      content,
    ) ||
    content.startsWith("Skill:")
  ) {
    return "procedural";
  }
  if (
    /\b(prefer|always|never|decision|fact:|preference|uses?|is named|email is|timezone)\b/i.test(
      content,
    ) ||
    REMEMBER_RE.test(content)
  ) {
    return "semantic";
  }
  if (/\b(currently|right now|wip|todo|today|this session|scratch)\b/i.test(c)) {
    return "working";
  }
  return "episodic";
}

export function defaultExpiresAt(
  tier: MemoryTier,
  createdAt: string,
): string | null {
  const days: Record<MemoryTier, number | null> = {
    working: 1,
    episodic: 30,
    semantic: 365,
    procedural: null,
  };
  const d = days[tier];
  if (d === null) return null;
  const t = new Date(createdAt);
  t.setTime(t.getTime() + d * 24 * 60 * 60 * 1000);
  return t.toISOString();
}

/**
 * Decay with configurable α/β, tier-aware access saturation, session boost.
 * session boost uses metadata.last_recalled_at when present.
 */
export function computeDecayScore(
  memory: Pick<
    Memory,
    "tier" | "importance" | "access_count" | "last_accessed_at" | "metadata"
  >,
  cfg: UmgConfig,
  now: string = nowIso(),
): number {
  const halfLife = cfg.consolidation.half_lives_days[memory.tier] || 14;
  const ageDays = daysBetween(memory.last_accessed_at, now);
  const timeFactor = Math.pow(0.5, ageDays / halfLife);

  const decayCfg = cfg.consolidation.decay;
  const sat =
    memory.tier === "procedural"
      ? decayCfg.procedural_access_saturation
      : decayCfg.access_saturation;
  const accessFactor = 1 - Math.exp(-memory.access_count / Math.max(1, sat));
  const alpha = decayCfg.alpha;
  const beta = decayCfg.beta;

  let score = memory.importance * (alpha * timeFactor + beta * accessFactor);

  if (memory.tier === "procedural") {
    score = Math.max(score, 0.4);
  }

  // Session-recency boost after recall
  const lastRecall = memory.metadata?.last_recalled_at;
  if (typeof lastRecall === "string" && decayCfg.session_boost > 0) {
    const hours =
      Math.abs(Date.parse(now) - Date.parse(lastRecall)) / (1000 * 60 * 60);
    if (!Number.isNaN(hours)) {
      const half = decayCfg.session_boost_half_life_hours || 4;
      const boost = decayCfg.session_boost * Math.pow(0.5, hours / half);
      score += boost;
    }
  }

  return clamp(score);
}

/**
 * Multi-factor re-rank. Weights from config. Optional hybrid cosine when embeddings present.
 */
export function rankForRecall(
  candidates: ScoredMemory[],
  cfg: UmgConfig,
  now: string = nowIso(),
  queryText?: string,
  queryEmbedding?: number[] | null,
): ScoredMemory[] {
  const w = cfg.recall.ranking_weights;
  const embOn = cfg.embeddings.enabled;
  const alpha = cfg.embeddings.hybrid_fts_weight;
  const beta = cfg.embeddings.hybrid_cosine_weight;
  const otherWeight = Math.max(0, 1 - alpha - beta);

  return candidates
    .map((m) => {
      const fts =
        m.score_breakdown?.fts ?? m.score_breakdown?.jaccard ?? m.score;
      const decay = computeDecayScore(m, cfg, now);
      const tierP = RECALL_TIER_PRIOR[m.tier];
      const ageDays = daysBetween(m.last_accessed_at, now);
      const recency = clamp(1 - ageDays / 30);
      const entity = queryText ? entityOverlapScore(queryText, m) : 0;

      const other =
        w.importance * m.importance +
        w.decay * decay +
        w.tier * tierP +
        w.recency * recency +
        w.entity * entity;
      // normalize other by sum of non-fts weights so hybrid scaling is stable
      const otherNormBase =
        w.importance + w.decay + w.tier + w.recency + w.entity || 1;
      const otherNorm = other / otherNormBase;

      let score: number;
      let cosine = 0;

      if (
        embOn &&
        queryEmbedding &&
        m.embedding &&
        m.embedding.length === queryEmbedding.length
      ) {
        cosine = (cosineSimilarity(queryEmbedding, m.embedding) + 1) / 2; // map [-1,1]→[0,1]
        const hybridLex = alpha * fts + beta * cosine;
        score = hybridLex + otherWeight * otherNorm;
      } else {
        score =
          w.fts * fts +
          w.importance * m.importance +
          w.decay * decay +
          w.tier * tierP +
          w.recency * recency +
          w.entity * entity;
      }

      return {
        ...m,
        decay_score: decay,
        score: clamp(score),
        score_breakdown: {
          fts,
          importance: m.importance,
          decay,
          tier: tierP,
          recency,
          entity,
          cosine,
        },
      };
    })
    .filter((m) => m.score >= cfg.recall.min_score)
    .sort((a, b) => b.score - a.score);
}

export function isLowInformation(content: string): boolean {
  const t = content.trim();
  if (t.length < 8) return true;
  if (GREETING_RE.test(t)) return true;
  if (tokenize(t).length < 2) return true;
  return false;
}

export { RECALL_TIER_PRIOR };
