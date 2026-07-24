/** Soft entity aliases for contradiction / slot matching. */

const ALIASES: Array<{ canonical: string; patterns: RegExp[] }> = [
  {
    canonical: "postgresql",
    patterns: [/\bpostgres(?:ql)?\b/i, /\bpg\b/i],
  },
  {
    canonical: "mysql",
    patterns: [/\bmysql\b/i, /\bmy\s*sql\b/i],
  },
  {
    canonical: "mongodb",
    patterns: [/\bmongodb\b/i, /\bmongo\b/i],
  },
  {
    canonical: "sqlite",
    patterns: [/\bsqlite\b/i],
  },
  {
    canonical: "redis",
    patterns: [/\bredis\b/i],
  },
  {
    canonical: "memcached",
    patterns: [/\bmemcached\b/i, /\bmemcache\b/i],
  },
  {
    canonical: "claude",
    patterns: [/\banthropic\s+claude\b/i, /\bclaude\b/i, /\banthropic\b/i],
  },
  {
    canonical: "openai",
    patterns: [/\bopenai\b/i, /\bgpt-?\d/i],
  },
  {
    canonical: "typescript",
    patterns: [/\btypescript\b/i, /\bts\b/i],
  },
  {
    canonical: "javascript",
    patterns: [/\bjavascript\b/i, /\bjs\b/i],
  },
  {
    canonical: "supabase",
    patterns: [/\bsupabase\b/i],
  },
  {
    canonical: "retell",
    patterns: [/\bretell\b/i],
  },
  {
    canonical: "stripe",
    patterns: [/\bstripe\b/i],
  },
  {
    canonical: "nextjs",
    patterns: [/\bnext\.?js\b/i],
  },
];

/** Normalize a single entity/token to a canonical form when known. */
export function normalizeEntityToken(token: string): string {
  const t = token.trim().toLowerCase();
  if (!t) return t;
  for (const a of ALIASES) {
    for (const re of a.patterns) {
      if (re.test(t) || re.test(token)) return a.canonical;
    }
  }
  return t;
}

/** Normalize free text so alias variants collapse before slot extraction. */
export function normalizeEntityText(text: string): string {
  let out = text;
  // Longer / more specific first
  const ordered = [...ALIASES].sort(
    (a, b) =>
      Math.max(...b.patterns.map((p) => p.source.length)) -
      Math.max(...a.patterns.map((p) => p.source.length)),
  );
  for (const a of ordered) {
    for (const re of a.patterns) {
      out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), a.canonical);
    }
  }
  return out;
}

export function entitiesEquivalent(a: string, b: string): boolean {
  return normalizeEntityToken(a) === normalizeEntityToken(b);
}
