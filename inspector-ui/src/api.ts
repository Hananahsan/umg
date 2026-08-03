export type Tier = "working" | "episodic" | "semantic" | "procedural";
export type TierHealth = "empty" | "healthy" | "filling" | "over_cap";
export type Source = "database" | "demo";

export interface TierOverview {
  tier: Tier;
  active: number;
  cap: number;
  fill: number;
  over_by: number;
  half_life_days: number;
  health: TierHealth;
  protected: boolean;
}

export interface Overview {
  source: Source;
  db_path: string;
  namespace: string;
  db_size_bytes: number;
  db_size_warn: boolean;
  total_active: number;
  archived: number;
  avg_decay: number;
  avg_importance: number;
  tiers: TierOverview[];
  global_cap: number;
  eviction_floor: number;
  merge_threshold: number;
  thin: boolean;
  read_only: true;
}

export async function fetchOverview(source?: Source): Promise<Overview> {
  const qs = source ? `?source=${source}` : "";
  const res = await fetch(`/api/overview${qs}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `overview failed (${res.status})`);
  }
  return (await res.json()) as Overview;
}

export const TIER_ORDER: Tier[] = [
  "working",
  "episodic",
  "semantic",
  "procedural",
];

/** Matches the CSS custom properties in index.css. */
export const TIER_COLOR: Record<Tier, string> = {
  working: "var(--color-working)",
  episodic: "var(--color-episodic)",
  semantic: "var(--color-semantic)",
  procedural: "var(--color-procedural)",
};

export const TIER_BLURB: Record<Tier, string> = {
  working: "current task scratch",
  episodic: "specific interactions",
  semantic: "facts, prefs, decisions",
  procedural: "skills and lessons",
};

export function formatHalfLife(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 365) return `${days % 1 === 0 ? days : days.toFixed(1)}d`;
  return `${(days / 365).toFixed(1)}y`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}
