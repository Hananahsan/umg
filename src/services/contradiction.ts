import { jaccard, normalizeText, tokenize } from "../util/text.js";

/**
 * Lightweight contradiction heuristics — no LLM.
 * Goal: catch "uses Postgres" vs "uses MySQL", or "is enabled" vs "is not enabled"
 * when the pair is about the same topic.
 *
 * Trade-off: prefers false negatives over aggressive wrong supersedes.
 */

const NEGATION_RE =
  /\b(not|never|no longer|isn't|isnt|aren't|arent|don't|dont|doesn't|doesnt|won't|wont|cannot|can't|cant|without)\b/i;

const VALUE_PATTERNS: RegExp[] = [
  /\b(?:uses?|using|use)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:is|are)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:prefers?|preference(?:\s+is)?)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:runs?\s+on|hosted\s+on|backed\s+by)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:version|v)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)*)/gi,
  // Require explicit is/: so "database uses X" does not capture "uses" as a value
  /\b(?:database|db|stack|framework|language|runtime)\s*(?:is|:)\s*([a-z0-9][\w.+#/-]*)/gi,
];

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "for",
  "of",
  "in",
  "on",
  "with",
  "is",
  "are",
  "be",
  "as",
  "at",
  "by",
  "from",
  "that",
  "this",
  "it",
  "we",
  "our",
  "user",
  "always",
  "never",
  "remember",
  "preference",
  "decision",
  "fact",
  "true",
  "false",
  // verbs / non-values that patterns sometimes capture
  "use",
  "uses",
  "using",
  "used",
  "run",
  "runs",
  "running",
  "prefer",
  "prefers",
  "storage",
  "backend",
  "service",
  "services",
]);

export interface ContradictionResult {
  contradicts: boolean;
  reason?: string;
  topic_overlap: number;
}

/** Extract simple slot values (use-targets, is-values, versions). */
export function extractValueSlots(text: string): string[] {
  const out = new Set<string>();
  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const v = m[1]?.toLowerCase();
      if (v && v.length > 1 && !STOP.has(v)) out.add(v);
    }
  }
  return [...out];
}

/** Topic tokens: content tokens minus stopwords and slot values. */
export function topicTokens(text: string): Set<string> {
  const slots = new Set(extractValueSlots(text));
  const tokens = tokenize(text).filter((t) => !STOP.has(t) && !slots.has(t));
  return new Set(tokens);
}

export function topicOverlap(a: string, b: string): number {
  const ta = topicTokens(a);
  const tb = topicTokens(b);
  if (ta.size === 0 || tb.size === 0) return jaccard(a, b);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}

/**
 * Detect if two memory texts contradict.
 * Requires enough topic overlap so unrelated facts don't trigger.
 */
export function detectContradiction(
  a: string,
  b: string,
  opts?: { min_topic_overlap?: number },
): ContradictionResult {
  const minTopic = opts?.min_topic_overlap ?? 0.28;
  const overlap = topicOverlap(a, b);
  if (overlap < minTopic) {
    return { contradicts: false, topic_overlap: overlap };
  }

  const slotsA = extractValueSlots(a);
  const slotsB = extractValueSlots(b);
  const jac = jaccard(a, b);

  // Same topic, different concrete values (Postgres vs MySQL, etc.)
  if (slotsA.length > 0 && slotsB.length > 0) {
    const setA = new Set(slotsA);
    const setB = new Set(slotsB);
    // Ignore shared filler; conflict when each side has a distinct concrete value
    const onlyA = [...setA].filter((x) => !setB.has(x) && !STOP.has(x));
    const onlyB = [...setB].filter((x) => !setA.has(x) && !STOP.has(x));
    if (onlyA.length > 0 && onlyB.length > 0 && jac < 0.95) {
      return {
        contradicts: true,
        reason: `conflicting_values:${onlyA[0]}≠${onlyB[0]}`,
        topic_overlap: overlap,
      };
    }
  }

  // Negation flip with high topic overlap
  const negA = hasNegation(a);
  const negB = hasNegation(b);
  if (negA !== negB && overlap >= 0.35 && jac >= 0.25 && jac < 0.85) {
    return {
      contradicts: true,
      reason: "negation_polarity",
      topic_overlap: overlap,
    };
  }

  // Correction language vs prior similar claim
  const correction =
    /\b(actually|instead|no longer|not anymore|changed to|switch(?:ed)? to|replace(?:d)? with)\b/i;
  if (
    (correction.test(a) || correction.test(b)) &&
    overlap >= 0.3 &&
    jac < 0.85 &&
    jac > 0.15
  ) {
    return {
      contradicts: true,
      reason: "correction_language",
      topic_overlap: overlap,
    };
  }

  // Explicit opposite boolean-ish
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (
    (na.includes(" enabled") && nb.includes(" disabled")) ||
    (na.includes(" disabled") && nb.includes(" enabled")) ||
    (na.includes(" true") && nb.includes(" false") && overlap >= 0.4) ||
    (na.includes(" false") && nb.includes(" true") && overlap >= 0.4)
  ) {
    return {
      contradicts: true,
      reason: "boolean_flip",
      topic_overlap: overlap,
    };
  }

  return { contradicts: false, topic_overlap: overlap };
}

/**
 * Write / prune conflict policy (v0.1.2 — additive-first, Mem0-inspired).
 *
 * Prefer ADD + later consolidation over aggressive in-place supersede when
 * confidence is only medium. Clear conflicts may still supersede.
 *
 * | Case                         | Action     |
 * |------------------------------|------------|
 * | No contradiction             | none       |
 * | Contradiction, not related   | none       |
 * | Clear + related conflict     | supersede  |
 * | Ambiguous related conflict   | defer      |
 *
 * "defer" means: insert the new memory, leave the prior active, let prune
 * multi-pass merge/supersede clean up later if the conflict becomes clear.
 */
export type WriteConflictAction = "none" | "supersede" | "defer";

export interface WriteConflictResolution extends ContradictionResult {
  action: WriteConflictAction;
  /** @deprecated use action === "supersede"; kept for call-site compatibility */
  supersede: boolean;
}

function isClearContradiction(
  c: ContradictionResult,
  similarityScore: number,
  mergeThreshold: number,
): boolean {
  if (!c.contradicts || !c.reason) return false;
  const reason = c.reason;

  // Strong structural conflicts
  if (reason.startsWith("conflicting_values") || reason === "boolean_flip") {
    return (
      similarityScore >= mergeThreshold * 0.65 || c.topic_overlap >= 0.4
    );
  }

  if (reason === "negation_polarity") {
    return (
      c.topic_overlap >= 0.45 && similarityScore >= mergeThreshold * 0.5
    );
  }

  if (reason === "correction_language") {
    return (
      c.topic_overlap >= 0.4 && similarityScore >= mergeThreshold * 0.5
    );
  }

  return false;
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

/**
 * Resolve whether to supersede, defer (add both), or ignore for write path.
 */
export function resolveWriteConflict(
  incoming: string,
  existing: string,
  similarityScore: number,
  mergeThreshold: number,
): WriteConflictResolution {
  const c = detectContradiction(incoming, existing);
  if (!c.contradicts) {
    return { ...c, action: "none", supersede: false };
  }
  if (!isRelated(c, similarityScore, mergeThreshold)) {
    return { ...c, action: "none", supersede: false };
  }
  if (isClearContradiction(c, similarityScore, mergeThreshold)) {
    return { ...c, action: "supersede", supersede: true };
  }
  // Ambiguous: additive-first
  return { ...c, action: "defer", supersede: false };
}

/**
 * @deprecated Prefer resolveWriteConflict. Returns supersede=true only for CLEAR conflicts.
 */
export function shouldSupersede(
  incoming: string,
  existing: string,
  similarityScore: number,
  mergeThreshold: number,
): ContradictionResult & { supersede: boolean } {
  const r = resolveWriteConflict(
    incoming,
    existing,
    similarityScore,
    mergeThreshold,
  );
  return {
    contradicts: r.contradicts,
    reason: r.reason,
    topic_overlap: r.topic_overlap,
    supersede: r.action === "supersede",
  };
}
