import { extractValueSlots, type WriteConflictResolution } from "./contradiction.js";
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
