import type { UmgApp } from "../app.js";
import { MEMORY_TIERS, type MemoryTier } from "../types.js";

/** Below this many active memories the UI offers the demo dataset instead. */
export const THIN_DB_THRESHOLD = 12;

export type TierHealth = "empty" | "healthy" | "filling" | "over_cap";

export interface TierOverview {
  tier: MemoryTier;
  active: number;
  cap: number;
  /** active/cap, clamped to 1 for the fill bar; `over_cap` carries the overflow. */
  fill: number;
  over_by: number;
  half_life_days: number;
  health: TierHealth;
  /** Procedural is exempt from cap eviction unless evict_procedural is on. */
  protected: boolean;
}

export interface Overview {
  source: "database" | "demo";
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

function healthFor(active: number, cap: number): TierHealth {
  if (active === 0) return "empty";
  if (active > cap) return "over_cap";
  if (active / cap >= 0.8) return "filling";
  return "healthy";
}

/**
 * Tier-by-tier snapshot. Reads come from store.stats() — the same source the
 * `stats` command uses — plus caps and half-lives from config.
 */
export async function buildOverview(
  app: UmgApp,
  source: "database" | "demo",
): Promise<Overview> {
  const stats = await app.store.stats(app.cfg.default_namespace);
  const cons = app.cfg.consolidation;

  const tiers: TierOverview[] = MEMORY_TIERS.map((tier) => {
    const active = stats.active_by_tier[tier] ?? 0;
    const cap = cons.caps[tier];
    return {
      tier,
      active,
      cap,
      fill: cap > 0 ? Math.min(1, active / cap) : 0,
      over_by: Math.max(0, active - cap),
      half_life_days: cons.half_lives_days[tier],
      health: healthFor(active, cap),
      protected: tier === "procedural" && !cons.evict_procedural,
    };
  });

  return {
    source,
    db_path: source === "demo" ? "(in-memory demo dataset)" : stats.db_path,
    namespace: stats.namespace_default,
    db_size_bytes: stats.db_size_bytes ?? 0,
    db_size_warn: stats.db_size_warn ?? false,
    total_active: stats.total_active,
    archived: stats.archived,
    avg_decay: stats.avg_decay,
    avg_importance: stats.avg_importance,
    tiers,
    global_cap: cons.caps.global,
    eviction_floor: cons.eviction_floor,
    merge_threshold: cons.merge_threshold,
    thin: source === "database" && stats.total_active < THIN_DB_THRESHOLD,
    read_only: true,
  };
}
