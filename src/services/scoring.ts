import type { UmgConfig } from "../config.js";
import type { Memory, MemoryTier, ScoredMemory } from "../types.js";
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

/** Compute importance at write time. */
export function computeImportance(
  content: string,
  tier: MemoryTier,
  supplied?: number,
): number {
  let score = TIER_PRIOR[tier];

  if (REMEMBER_RE.test(content)) score += 0.2;
  if (CORRECTION_RE.test(content)) score += 0.15;

  const tokens = tokenize(content);
  // Entity-dense short facts (identifiers, versions, paths)
  const entityLike = tokens.filter((t) => /[0-9_/.-]/.test(t) || /^[A-Z]{2,}$/.test(t));
  if (tokens.length > 0 && tokens.length <= 40 && entityLike.length >= 1) {
    score += 0.1;
  }

  if (content.length > 2000) score -= 0.1;
  if (GREETING_RE.test(content.trim())) score -= 0.4;
  if (tokens.length < 3 && !REMEMBER_RE.test(content)) score -= 0.15;

  score = clamp(score);

  if (supplied !== undefined && !Number.isNaN(supplied)) {
    // Soft blend: agent 70% / computed 30%
    score = clamp(0.7 * clamp(supplied) + 0.3 * score);
  }
  return score;
}

/** Heuristic auto-tier classification. */
export function autoTier(content: string, explicit?: MemoryTier): MemoryTier {
  if (explicit) return explicit;
  const c = content.toLowerCase();

  if (
    /\b(how to|steps?:|procedure|playbook|skill:|workflow|runbook)\b/i.test(content) ||
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
  // Default: episodic interaction
  return "episodic";
}

/** Default expiry by tier from created_at. */
export function defaultExpiresAt(tier: MemoryTier, createdAt: string): string | null {
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
 * Decay score from time + access.
 * decay = importance * (α * time_factor + β * access_factor)
 * time_factor = 0.5 ** (age_days / half_life)
 */
export function computeDecayScore(
  memory: Pick<Memory, "tier" | "importance" | "access_count" | "last_accessed_at">,
  cfg: UmgConfig,
  now: string = nowIso(),
): number {
  const halfLife = cfg.consolidation.half_lives_days[memory.tier] || 14;
  const ageDays = daysBetween(memory.last_accessed_at, now);
  const timeFactor = Math.pow(0.5, ageDays / halfLife);
  const accessSaturation = 5;
  const accessFactor = 1 - Math.exp(-memory.access_count / accessSaturation);
  const alpha = 0.65;
  const beta = 0.35;
  let score = memory.importance * (alpha * timeFactor + beta * accessFactor);
  // Procedural floor
  if (memory.tier === "procedural") {
    score = Math.max(score, 0.4);
  }
  return clamp(score);
}

/** Re-rank FTS hits with multi-factor score. */
export function rankForRecall(
  candidates: ScoredMemory[],
  cfg: UmgConfig,
  now: string = nowIso(),
): ScoredMemory[] {
  const wFts = 0.4;
  const wImp = 0.2;
  const wDecay = 0.2;
  const wTier = 0.1;
  const wRecency = 0.1;

  return candidates
    .map((m) => {
      const fts = m.score_breakdown?.fts ?? m.score_breakdown?.jaccard ?? m.score;
      const decay = computeDecayScore(m, cfg, now);
      const tierP = RECALL_TIER_PRIOR[m.tier];
      const ageDays = daysBetween(m.last_accessed_at, now);
      const recency = clamp(1 - ageDays / 30);
      const score =
        wFts * fts +
        wImp * m.importance +
        wDecay * decay +
        wTier * tierP +
        wRecency * recency;
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
