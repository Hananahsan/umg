import type { UmgConfig } from "../config.js";
import type { Memory, MemoryTier } from "../types.js";

/**
 * How long a memory is expected to survive, as a comparable structure.
 *
 * Clause B of the retention invariant is "a memory's effective lifetime never
 * silently decreases". That phrase has been interpreted differently by each
 * thing that touched it — the tier-downgrade fix read it as "tier", and the
 * fix for *that* read it as "tier and expiry" and promptly shortened an
 * extended expiry. Every path that can change a memory's retention class must
 * derive lifetime from this one function so there is nothing left to
 * interpret.
 */

/**
 * The row-intrinsic inputs to survival. Deliberately a structure and not a
 * single scalar — see `lifetimeRegression` for why.
 */
export interface LifetimeProfile {
  /** Epoch ms, or null for "never expires", which dominates any date. */
  expires_at_ms: number | null;
  /** Tier half-life in days: how fast decay_score falls. */
  half_life_days: number;
  /** Floor decay_score cannot fall below (procedural only, today). */
  decay_floor: number;
}

/** Floor applied to decay_score by tier. Mirrors computeDecayScore. */
function decayFloorFor(tier: MemoryTier): number {
  return tier === "procedural" ? 0.4 : 0;
}

export function effectiveLifetime(
  row: Pick<Memory, "tier" | "expires_at">,
  cfg: UmgConfig,
): LifetimeProfile {
  return {
    expires_at_ms: row.expires_at ? Date.parse(row.expires_at) : null,
    half_life_days: cfg.consolidation.half_lives_days[row.tier],
    decay_floor: decayFloorFor(row.tier),
  };
}

/**
 * Which components of effective lifetime got worse.
 *
 * This is a dominance check, not a comparison of two scalars, and that is a
 * deliberate choice. Collapsing days-until-expiry, half-life in days and a
 * unitless decay floor into one number requires inventing weights, and an
 * invented weight is exactly the kind of proxy that has produced six bugs in
 * this codebase: the number would compare cleanly while hiding which input
 * moved. Requiring every component to hold or improve is strictly stronger,
 * and a failure names the component.
 *
 * Returns the weakened component names — empty means lifetime held or grew.
 */
export function lifetimeRegression(
  before: LifetimeProfile,
  after: LifetimeProfile,
): string[] {
  const weakened: string[] = [];

  // null ("never") dominates. Going from never to a date is a regression;
  // going from a date to never is an improvement.
  if (before.expires_at_ms === null && after.expires_at_ms !== null) {
    weakened.push("expires_at");
  } else if (
    before.expires_at_ms !== null &&
    after.expires_at_ms !== null &&
    after.expires_at_ms < before.expires_at_ms
  ) {
    weakened.push("expires_at");
  }

  if (after.half_life_days < before.half_life_days) weakened.push("half_life");
  if (after.decay_floor < before.decay_floor) weakened.push("decay_floor");

  return weakened;
}

/**
 * WHAT THIS DELIBERATELY EXCLUDES: cap pressure.
 *
 * Tier caps affect survival — a row in a tier at its cap is an eviction
 * candidate, one in a tier with headroom is not — but cap risk is not a
 * property of the row. It depends on the population (how many rows share the
 * tier) and it is *rank*-based, not magnitude-based: eviction takes the lowest
 * decay_score rows until the tier is under cap, so a row's exposure changes as
 * other rows arrive and leave, without the row changing at all.
 *
 * Folding that into a per-row lifetime value would mean either passing the
 * whole tier population into every call, or inventing a static proxy for a
 * dynamic quantity. The second is how this class of bug gets made.
 *
 * So it is excluded, and exposed separately for callers that do have the
 * population. The real gap this leaves is genuine and worth stating: an
 * upgrade into a tier that sits at its cap can raise nominal lifetime while
 * lowering survival probability. Procedural is exempt while
 * evict_procedural is false, so the case that bites is episodic -> semantic
 * into a full semantic tier.
 */
export function capHeadroom(
  tier: MemoryTier,
  occupancy: number,
  cfg: UmgConfig,
): { cap: number; occupancy: number; headroom: number; protected: boolean } {
  const cap = cfg.consolidation.caps[tier];
  return {
    cap,
    occupancy,
    headroom: cap - occupancy,
    protected: tier === "procedural" && !cfg.consolidation.evict_procedural,
  };
}
