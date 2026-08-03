import { extractValueSlots, type WriteConflictResolution } from "./contradiction.js";
import { defaultExpiresAt } from "./scoring.js";
import { effectiveLifetime, lifetimeRegression } from "./lifetime.js";
import type { UmgConfig } from "../config.js";
import { longerLivedTier, type Memory, type MemoryTier } from "../types.js";
import { normalizeEntityText, normalizeEntityToken } from "../util/entity-normalize.js";
import { tokenize } from "../util/text.js";

/**
 * Merge policy — the counterpart to the additive-first conflict policy.
 *
 * Supersede has always been confidence-gated and falls back to keeping both on
 * ambiguity. Merge had neither: it was a bare `similarity >= threshold`, and
 * above the line one memory was discarded outright. That is not a safety
 * mechanism, because the similarity scale does not separate "same fact
 * reworded" from "same template, different value" — measured, a distinct
 * staging/production URL pair outscored six of seven genuine duplicates.
 *
 * So merging now requires positive confidence that the two state the same
 * fact, and anything short of that keeps both rows and records why.
 */

/**
 * The tier and expiry a row should end up with after absorbing a write at
 * `incomingTier`, plus a metadata trace when it changed.
 *
 * Two rules, both clause B ("retention class never silently weakens"):
 *
 *  - tier only ever moves to the longer-lived of the two;
 *  - expiry only ever moves later. Recomputing it from the tier default alone
 *    is not safe: a row whose expires_at was extended past its tier default
 *    would have that extension revoked by an *upgrade*. Measured, an episodic
 *    row extended to 2029 came back from a semantic upgrade expiring in 2027.
 */
export interface TierUpgrade {
  tier: MemoryTier;
  expires_at: string | null;
  /**
   * The complete metadata to write. Callers pass their own additions in and
   * use this wholesale — there is no fragment to merge and therefore no spread
   * order to get wrong. An earlier version returned only the trace and left
   * the caller to combine it; mergeInto built its metadata object before
   * calling, spread `target.metadata` over the result, and silently dropped
   * the trace. No error, no test failure, just a missing field.
   */
  metadata: Record<string, unknown>;
}

export function resolveTierUpgrade(
  target: Pick<Memory, "tier" | "expires_at" | "created_at" | "metadata">,
  incomingTier: MemoryTier,
  now: string,
  /** The caller's own metadata additions, e.g. merge_count. */
  additions: Record<string, unknown> = {},
): TierUpgrade {
  const tier = longerLivedTier(target.tier, incomingTier);
  const base = { ...(target.metadata ?? {}), ...additions };

  if (tier === target.tier) {
    return { tier, expires_at: target.expires_at ?? null, metadata: base };
  }

  const fromDefault = defaultExpiresAt(tier, target.created_at);
  const current = target.expires_at ?? null;
  // null means "never expires", which outranks any date on both sides.
  const expires_at =
    fromDefault === null || current === null
      ? null
      : current > fromDefault
        ? current
        : fromDefault;

  return {
    tier,
    expires_at,
    metadata: {
      ...base,
      // Written last so a caller's additions cannot clobber the trace. A row
      // silently changing retention class is exactly what the inspector should
      // be able to explain rather than leave to inference.
      tier_upgraded_from: target.tier,
      tier_upgraded_to: tier,
      tier_upgraded_at: now,
    },
  };
}

/**
 * Assert that an upgrade did not weaken effective lifetime.
 *
 * resolveTierUpgrade is constructed so this cannot fail, but it is checked
 * rather than assumed: the previous version of that function was also believed
 * correct and shortened an extended expiry by two years. Returns the weakened
 * components, empty when lifetime held or grew.
 */
export function tierUpgradeRegression(
  target: Pick<Memory, "tier" | "expires_at">,
  upgrade: Pick<TierUpgrade, "tier" | "expires_at">,
  cfg: UmgConfig,
): string[] {
  return lifetimeRegression(
    effectiveLifetime(target, cfg),
    effectiveLifetime({ tier: upgrade.tier, expires_at: upgrade.expires_at }, cfg),
  );
}

export type MergeAction = "merge" | "defer" | "none";

export interface MergeResolution {
  action: MergeAction;
  /** 0–1 confidence that the two texts state the same fact. */
  confidence: number;
  /** Stable code, safe to render and to assert on. */
  reason: string;
  /** Human-facing detail for the inspector, when there is one. */
  detail?: string;
}

/** Tokens that carry no claim, so their presence on one side is not evidence. */
const FILLER = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with", "at",
  "by", "from", "that", "this", "it", "is", "are", "be", "as", "all", "every",
  "our", "we", "its", "their", "also", "now", "then", "just", "still", "here",
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    tokenize(normalizeEntityText(text))
      .map(normalizeEntityToken)
      .filter((t) => !FILLER.has(t)),
  );
}

/**
 * Decide whether two similar memories may be collapsed.
 *
 * `conflict` is the resolution the caller already computed, so the
 * contradiction pass is not repeated.
 */
export function resolveMerge(
  incoming: string,
  existing: string,
  similarity: number,
  conflict: WriteConflictResolution,
  mergeThreshold: number,
  minConfidence: number,
): MergeResolution {
  if (similarity < mergeThreshold) {
    return { action: "none", confidence: 0, reason: "below_threshold" };
  }

  // Different subjects. Both are true; collapsing either into the other loses
  // a fact. Never merge at any similarity.
  if (conflict.scope_divergent) {
    return {
      action: "defer",
      confidence: 0,
      reason: "scope_divergent",
      detail: conflict.scope_reason,
    };
  }

  // A live contradiction belongs to the supersede/defer path, not here.
  if (conflict.contradicts) {
    return {
      action: "none",
      confidence: 0,
      reason: "contradiction",
      detail: conflict.reason,
    };
  }

  // Each side asserts a value the other does not. Even without a contradiction
  // verdict (the detector needs topic overlap and skips near-identical text),
  // differing values mean these are not the same statement.
  const slotsA = new Set(extractValueSlots(incoming));
  const slotsB = new Set(extractValueSlots(existing));
  const onlyA = [...slotsA].filter((s) => !slotsB.has(s));
  const onlyB = [...slotsB].filter((s) => !slotsA.has(s));
  if (onlyA.length > 0 && onlyB.length > 0) {
    return {
      action: "defer",
      confidence: 0,
      reason: "differing_values",
      detail: `${onlyA[0]}≠${onlyB[0]}`,
    };
  }

  // A reworded duplicate is one-sided: one text contains the other's content
  // and adds to it. When both sides carry content the other lacks, they are
  // making different points, and confidence drops in proportion.
  const ta = contentTokens(incoming);
  const tb = contentTokens(existing);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const smaller = Math.max(1, Math.min(ta.size, tb.size));
  const twoSided = Math.min(ta.size - shared, tb.size - shared) / smaller;

  const confidence = Math.max(0, Math.min(1, similarity * (1 - twoSided)));

  if (confidence >= minConfidence) {
    return { action: "merge", confidence, reason: "near_duplicate" };
  }
  return {
    action: "defer",
    confidence,
    reason: "low_merge_confidence",
    detail: `confidence ${confidence.toFixed(2)} < ${minConfidence}`,
  };
}
