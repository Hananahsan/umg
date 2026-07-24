import { uniqueStrings } from "./text.js";

const TECH =
  /\b(?:PostgreSQL|Postgres|Supabase|Next\.js|TypeScript|JavaScript|Python|Retell|Stripe|Redis|Memcached|SQLite|MySQL|MongoDB|OpenAI|Anthropic|Claude|Cursor|Codex|Vercel|Webflow|Linear|GraphQL|REST|Kafka|Docker|Kubernetes|Ollama)\b/gi;

/**
 * Lightweight entity extraction for recall boosting and retain enrichment.
 * Shared by reflect + scoring so heuristics do not drift.
 */
export function extractEntities(text: string): string[] {
  if (!text?.trim()) return [];
  const entities: string[] = [];

  const caps = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
  if (caps) entities.push(...caps);

  const tech = text.match(TECH);
  if (tech) entities.push(...tech);

  const versions = text.match(/\bv?\d+\.\d+(?:\.\d+)?\b/g);
  if (versions) entities.push(...versions);

  // Path-like / package-like tokens
  const paths = text.match(/\b[a-z][\w-]*\/[\w./-]+\b/gi);
  if (paths) entities.push(...paths.slice(0, 4));

  return uniqueStrings(entities).slice(0, 12);
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Recall-oriented entity overlap: fraction of query entities hit on the memory.
 * If memory.entities is empty, fall back to content substring matches (half credit per hit).
 */
export function entityOverlapScore(
  queryText: string,
  memory: { entities?: string[]; content?: string },
): number {
  const q = extractEntities(queryText).map(norm).filter(Boolean);
  if (q.length === 0) return 0;

  const memEnt = new Set((memory.entities ?? []).map(norm).filter(Boolean));
  const content = (memory.content ?? "").toLowerCase();

  let hits = 0;
  for (const e of q) {
    if (memEnt.has(e)) {
      hits += 1;
      continue;
    }
    // Partial content fallback when entities not populated
    if (e.length >= 3 && content.includes(e)) {
      hits += 0.5;
    }
  }
  return Math.min(1, hits / q.length);
}

/** Jaccard on normalized string sets. */
export function setJaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map(norm).filter(Boolean));
  const sb = new Set(b.map(norm).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

export function setIntersectionSize(a: string[], b: string[]): number {
  const sb = new Set(b.map(norm).filter(Boolean));
  let n = 0;
  for (const x of a) {
    if (sb.has(norm(x))) n++;
  }
  return n;
}
