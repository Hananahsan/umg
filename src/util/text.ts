/** Normalize text for hashing / similarity. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(s: string): string[] {
  const n = normalizeText(s);
  if (!n) return [];
  return n.split(" ").filter((t) => t.length > 1);
}

/** Jaccard similarity over token sets. */
export function jaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Simple content fingerprint for exact-ish dedup. */
export function contentHash(s: string): string {
  const n = normalizeText(s);
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < n.length; i++) {
    h ^= n.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function clamp(n: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, n));
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

export function summarize(content: string, max = 160): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return truncate(oneLine, max);
}

/** Build FTS5 query from free text — escape quotes, OR meaningful tokens. */
export function toFtsQuery(text: string): string {
  const tokens = tokenize(text).slice(0, 12);
  if (tokens.length === 0) return '""';
  // Phrase-ish: each token as prefix match; join with OR for recall
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
}

export function uniqueStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x.trim());
  }
  return out;
}

export function daysBetween(isoA: string, isoB: string): number {
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(b - a) / (1000 * 60 * 60 * 24);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
