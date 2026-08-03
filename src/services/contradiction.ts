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

/**
 * Whole-token values, matched and removed before the lead-in patterns below.
 *
 * These have to come first because they contain characters the lead-in
 * patterns stop at. A URL after "is" used to yield the slot `https` — the
 * character class excludes `:` — so every URL in the database reduced to the
 * same value and two different URLs never looked different.
 */
const LITERAL_PATTERNS: RegExp[] = [
  /\bhttps?:\/\/[^\s,;)"'<>]+/gi,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi,
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|org|net|io|dev|app|co|ai|sh|cloud|local)\b/gi,
];

const VALUE_PATTERNS: RegExp[] = [
  /\b(?:uses?|using|use)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:is|are)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:prefers?|preference(?:\s+is)?)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:runs?\s+on|hosted\s+on|backed\s+by|deployed\s+(?:to|on))\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:set\s+to|configured\s+as|defaults?\s+to|points?\s+to|targets?|listens?\s+on)\s+([a-z0-9][\w.+#/-]*)/gi,
  /\b(?:version|v)\s*[:=]?\s*([0-9]+(?:\.[0-9]+)*)/gi,
  /\bport\s*[:=]?\s*([0-9]{2,5})\b/gi,
  /\b(?:database|db|stack|framework|language|runtime|region|provider)\s*(?:is|:)\s*([a-z0-9][\w.+#/-]*)/gi,
];

/**
 * Closed vocabularies where two different members mean the statements are
 * about *different subjects*, not conflicting claims about one subject.
 *
 * This is the difference between "the database is postgres" / "the database is
 * mysql" — one fact, two claims, one of which must lose — and "the staging URL
 * is X" / "the production URL is Y", which are both true forever. Without it,
 * teaching the extractor to see URLs just moves the data loss from merge to
 * supersede: the pair scores 0.925 confidence and one gets archived.
 *
 * Kept deliberately small and high-precision. Ambiguous words ("test", "read",
 * "write") are excluded — a false divergence only costs a missed merge, but it
 * also suppresses genuine contradictions, so the bar for adding is real
 * evidence of the scoping sense dominating.
 */
const SCOPE_SETS: ReadonlyArray<Readonly<Record<string, readonly string[]>>> = [
  {
    production: ["production", "prod"],
    staging: ["staging", "stage"],
    development: ["development", "dev"],
    preview: ["preview"],
    sandbox: ["sandbox"],
    qa: ["qa"],
    uat: ["uat"],
  },
  {
    primary: ["primary", "leader", "writer"],
    replica: ["replica", "secondary", "follower"],
    standby: ["standby", "failover"],
  },
  {
    ios: ["ios"],
    android: ["android"],
    desktop: ["desktop"],
    cli: ["cli"],
  },
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
  /**
   * The two texts are scoped to different subjects (different environments,
   * replica roles, platforms). They are not in conflict and must not be
   * collapsed into one another — both are true.
   */
  scope_divergent?: boolean;
  /** e.g. "staging≠production" when scope_divergent. */
  scope_reason?: string;
}

/** Trailing punctuation a URL or domain picks up from prose. */
function trimLiteral(value: string): string {
  return value.replace(/[.,;:!?)\]}'"]+$/, "").replace(/\/+$/, "").toLowerCase();
}

export function extractValueSlots(text: string): string[] {
  const normalized = normalizeEntityText(text);
  const out = new Set<string>();

  // Literals first, then blank them out so the lead-in patterns below cannot
  // re-match a fragment of one (an unblanked URL yields the slot `https`).
  let remaining = normalized;
  for (const re of LITERAL_PATTERNS) {
    re.lastIndex = 0;
    remaining = remaining.replace(re, (match) => {
      const v = trimLiteral(match);
      if (v.length > 1) out.add(v);
      return " ".repeat(match.length);
    });
  }

  for (const re of VALUE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(remaining)) !== null) {
      const raw = m[1];
      if (!raw || raw.length <= 1) continue;
      const v = normalizeEntityToken(raw);
      if (v && !STOP.has(v)) out.add(v);
    }
  }
  return [...out];
}

/** Canonical scope members present in a text, per scope set. */
function scopesIn(text: string): Array<Set<string>> {
  const lower = ` ${normalizeText(text)} `;
  return SCOPE_SETS.map((set) => {
    const found = new Set<string>();
    for (const [canonical, aliases] of Object.entries(set)) {
      for (const alias of aliases) {
        if (lower.includes(` ${alias} `)) {
          found.add(canonical);
          break;
        }
      }
    }
    return found;
  });
}

/**
 * True when each text names a different member of the same scope vocabulary.
 * Overlapping scopes (both mention production) are not divergent — those may
 * still be genuine contradictions.
 */
export function detectScopeDivergence(
  a: string,
  b: string,
): { diverges: boolean; reason?: string } {
  const sa = scopesIn(a);
  const sb = scopesIn(b);
  for (let i = 0; i < sa.length; i++) {
    const inA = sa[i];
    const inB = sb[i];
    if (inA.size === 0 || inB.size === 0) continue;
    const shared = [...inA].some((s) => inB.has(s));
    if (shared) continue;
    return {
      diverges: true,
      reason: `${[...inA].sort().join("/")}≠${[...inB].sort().join("/")}`,
    };
  }
  return { diverges: false };
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

  // Checked before the topic-overlap gate and before any conflict rule: two
  // statements scoped to different subjects are not in conflict at any
  // similarity, and callers need the signal in order to refuse to merge them.
  const scope = detectScopeDivergence(aN, bN);
  if (scope.diverges) {
    return {
      contradicts: false,
      topic_overlap: overlap,
      confidence: 0,
      scope_divergent: true,
      scope_reason: scope.reason,
    };
  }

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
 * - distinct when the two are scoped to different subjects — keep both, and
 *   never merge them (they are not near-duplicates however alike they read)
 * - supersede only when confidence ≥ minConfidence (default 0.75) and related
 * - defer when 0.4 ≤ confidence < minConfidence
 * - none otherwise
 */
export type WriteConflictAction = "none" | "supersede" | "defer" | "distinct";

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
  // Different subjects: not a conflict, but also not a duplicate. Callers must
  // keep both, so this outranks the "no contradiction -> nothing to do" exit.
  if (c.scope_divergent) {
    return { ...c, action: "distinct", supersede: false };
  }
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
