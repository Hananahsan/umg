import {
  normalizeEntityText,
  normalizeEntityToken,
} from "../util/entity-normalize.js";
import { jaccard, normalizeText, tokenize } from "../util/text.js";

/**
 * Contradiction v2 — confidence-scored, alias-normalized, additive-first.
 * Prefer false negatives over wrong supersedes.
 */

const NEGATION_RE =
  /\b(not|never|no longer|isn't|isnt|aren't|arent|don't|dont|doesn't|doesnt|won't|wont|cannot|can't|cant|without)\b/i;

const VALUE_PATTERNS: RegExp[] = [
  /\b(?:uses?|using|use)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:is|are)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:prefers?|preference(?:\s+is)?)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:runs?\s+on|hosted\s+on|backed\s+by)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:version|v)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)*)/gi,
  /\b(?:database|db|stack|framework|language|runtime)\s*(?:is|:)\s*([a-z0-9][\w.+#/-]*)/gi,
];

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "for", "of", "in", "on", "with",
  "is", "are", "be", "as", "at", "by", "from", "that", "this", "it", "we",
  "our", "user", "always", "never", "remember", "preference", "decision",
  "fact", "true", "false", "use", "uses", "using", "used", "run", "runs",
  "running", "prefer", "prefers", "storage", "backend", "service", "services",
]);

export interface ContradictionResult {
  contradicts: boolean;
  reason?: string;
  topic_overlap: number;
  /** 0–1 confidence; supersede only when ≥ supersede_min_confidence (default 0.75). */
  confidence: number;
}

export function extractValueSlots(text: string): string[] {
  const normalized = normalizeEntityText(text);
  const out = new Set<string>();
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized)) !== null) {
      const raw = m[1];
      if (!raw || raw.length <= 1) continue;
      const v = normalizeEntityToken(raw);
      if (v && !STOP.has(v)) out.add(v);
    }
  }
  return [...out];
}

export function topicTokens(text: string): Set<string> {
  const slots = new Set(extractValueSlots(text));
  const tokens = tokenize(normalizeEntityText(text)).filter(
    (t) => !STOP.has(t) && !slots.has(normalizeEntityToken(t)),
  );
  return new Set(tokens);
}

export function topicOverlap(a: string, b: string): number {
  const ta = topicTokens(a);
  const tb = topicTokens(b);
  if (ta.size === 0 || tb.size === 0) {
    return jaccard(normalizeEntityText(a), normalizeEntityText(b));
  }
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}

function confidenceFor(
  reason: string,
  overlap: number,
  jac: number,
): number {
  if (reason.startsWith("conflicting_values")) {
    return clamp01(0.85 + 0.1 * overlap);
  }
  if (reason === "boolean_flip") return 0.9;
  if (reason === "negation_polarity") {
    return clamp01(0.55 + 0.25 * overlap + 0.1 * jac);
  }
  if (reason === "correction_language") {
    return clamp01(0.5 + 0.3 * overlap + 0.1 * jac);
  }
  return 0.5;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function detectContradiction(
  a: string,
  b: string,
  opts?: { min_topic_overlap?: number },
): ContradictionResult {
  const minTopic = opts?.min_topic_overlap ?? 0.28;
  const aN = normalizeEntityText(a);
  const bN = normalizeEntityText(b);
  const overlap = topicOverlap(aN, bN);
  if (overlap < minTopic) {
    return { contradicts: false, topic_overlap: overlap, confidence: 0 };
  }

  const slotsA = extractValueSlots(aN);
  const slotsB = extractValueSlots(bN);
  const jac = jaccard(aN, bN);

  if (slotsA.length > 0 && slotsB.length > 0) {
    const setA = new Set(slotsA);
    const setB = new Set(slotsB);
    const onlyA = [...setA].filter((x) => !setB.has(x) && !STOP.has(x));
    const onlyB = [...setB].filter((x) => !setA.has(x) && !STOP.has(x));
    if (onlyA.length > 0 && onlyB.length > 0 && jac < 0.95) {
      const reason = `conflicting_values:${onlyA[0]}≠${onlyB[0]}`;
      return {
        contradicts: true,
        reason,
        topic_overlap: overlap,
        confidence: confidenceFor(reason, overlap, jac),
      };
    }
  }

  const negA = hasNegation(aN);
  const negB = hasNegation(bN);
  if (negA !== negB && overlap >= 0.35 && jac >= 0.25 && jac < 0.85) {
    const reason = "negation_polarity";
    return {
      contradicts: true,
      reason,
      topic_overlap: overlap,
      confidence: confidenceFor(reason, overlap, jac),
    };
  }

  const correction =
    /\b(actually|instead|no longer|not anymore|changed to|switch(?:ed)? to|replace(?:d)? with)\b/i;
  if (
    (correction.test(aN) || correction.test(bN)) &&
    overlap >= 0.3 &&
    jac < 0.85 &&
    jac > 0.15
  ) {
    const reason = "correction_language";
    return {
      contradicts: true,
      reason,
      topic_overlap: overlap,
      confidence: confidenceFor(reason, overlap, jac),
    };
  }

  const na = normalizeText(aN);
  const nb = normalizeText(bN);
  if (
    (na.includes(" enabled") && nb.includes(" disabled")) ||
    (na.includes(" disabled") && nb.includes(" enabled")) ||
    (na.includes(" true") && nb.includes(" false") && overlap >= 0.4) ||
    (na.includes(" false") && nb.includes(" true") && overlap >= 0.4)
  ) {
    const reason = "boolean_flip";
    return {
      contradicts: true,
      reason,
      topic_overlap: overlap,
      confidence: confidenceFor(reason, overlap, jac),
    };
  }

  return { contradicts: false, topic_overlap: overlap, confidence: 0 };
}

/**
 * Additive-first write policy:
 * - supersede only when confidence ≥ minConfidence (default 0.75) and related
 * - defer when 0.4 ≤ confidence < minConfidence
 * - none otherwise
 */
export type WriteConflictAction = "none" | "supersede" | "defer";

export interface WriteConflictResolution extends ContradictionResult {
  action: WriteConflictAction;
  supersede: boolean;
}

function isRelated(
  c: ContradictionResult,
  similarityScore: number,
  mergeThreshold: number,
): boolean {
  return (
    similarityScore >= mergeThreshold * 0.55 || c.topic_overlap >= 0.28
  );
}

export function resolveWriteConflict(
  incoming: string,
  existing: string,
  similarityScore: number,
  mergeThreshold: number,
  minConfidence = 0.75,
): WriteConflictResolution {
  const c = detectContradiction(incoming, existing);
  if (!c.contradicts) {
    return { ...c, action: "none", supersede: false };
  }
  if (!isRelated(c, similarityScore, mergeThreshold)) {
    return { ...c, action: "none", supersede: false };
  }
  if (c.confidence >= minConfidence) {
    return { ...c, action: "supersede", supersede: true };
  }
  if (c.confidence >= 0.4) {
    return { ...c, action: "defer", supersede: false };
  }
  return { ...c, action: "none", supersede: false };
}

export function shouldSupersede(
  incoming: string,
  existing: string,
  similarityScore: number,
  mergeThreshold: number,
  minConfidence = 0.75,
): ContradictionResult & { supersede: boolean } {
  const r = resolveWriteConflict(
    incoming,
    existing,
    similarityScore,
    mergeThreshold,
    minConfidence,
  );
  return {
    contradicts: r.contradicts,
    reason: r.reason,
    topic_overlap: r.topic_overlap,
    confidence: r.confidence,
    supersede: r.action === "supersede",
  };
}
