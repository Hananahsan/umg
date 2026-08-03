import { describe, it, expect } from "vitest";
import { defaultConfig } from "../src/config.js";
import {
  capHeadroom,
  effectiveLifetime,
  expiryForWrite,
  lifetimeRegression,
} from "../src/services/lifetime.js";
import {
  resolveTierUpgrade,
  tierUpgradeRegression,
} from "../src/services/merge-policy.js";
import { MEMORY_TIERS, type MemoryTier } from "../src/types.js";

/**
 * Clause B, as a function rather than a phrase.
 *
 * Every previous attempt at "retention class never weakens" was an informal
 * reading — first "tier", then "tier and expiry", and the second reading
 * shipped a fix that shortened an extended expiry by two years. These tests
 * pin the definition itself so the next implementer inherits a check rather
 * than a sentence.
 */

const cfg = defaultConfig();
const NOW = "2026-08-03T00:00:00.000Z";
const CREATED = "2026-01-01T00:00:00.000Z";

const row = (tier: MemoryTier, expires_at: string | null) => ({
  tier,
  expires_at,
  created_at: CREATED,
  metadata: {} as Record<string, unknown>,
});

describe("effectiveLifetime", () => {
  it("increases monotonically across the tier ordering", () => {
    // Half-life and decay floor must never fall as tier rises, or the
    // "longer-lived tier" ordering the upgrade relies on would be a lie.
    for (let i = 0; i < MEMORY_TIERS.length - 1; i++) {
      const lower = effectiveLifetime(row(MEMORY_TIERS[i], null), cfg);
      const higher = effectiveLifetime(row(MEMORY_TIERS[i + 1], null), cfg);
      expect(higher.half_life_days).toBeGreaterThan(lower.half_life_days);
      expect(higher.decay_floor).toBeGreaterThanOrEqual(lower.decay_floor);
    }
  });

  it("treats a null expiry as dominating any date", () => {
    const never = effectiveLifetime(row("semantic", null), cfg);
    const dated = effectiveLifetime(row("semantic", "2099-01-01T00:00:00Z"), cfg);
    expect(lifetimeRegression(dated, never)).toEqual([]);
    expect(lifetimeRegression(never, dated)).toEqual(["expires_at"]);
  });

  it("names the component that weakened", () => {
    expect(
      lifetimeRegression(
        effectiveLifetime(row("procedural", null), cfg),
        effectiveLifetime(row("working", null), cfg),
      ),
    ).toEqual(["half_life", "decay_floor"]);

    expect(
      lifetimeRegression(
        effectiveLifetime(row("semantic", "2030-01-01T00:00:00Z"), cfg),
        effectiveLifetime(row("semantic", "2027-01-01T00:00:00Z"), cfg),
      ),
    ).toEqual(["expires_at"]);
  });
});

describe("resolveTierUpgrade never weakens lifetime", () => {
  /** Every tier pair, against expiries above and below the tier default. */
  const expiries: Array<string | null> = [
    null,
    "2026-08-04T00:00:00.000Z", // imminent
    "2029-04-29T00:00:00.000Z", // extended well past most tier defaults
  ];

  it.each(
    MEMORY_TIERS.flatMap((from) =>
      MEMORY_TIERS.flatMap((to) =>
        expiries.map((exp) => ({ from, to, exp: exp ?? "never" })),
      ),
    ),
  )("$from + $to write, expiry $exp", ({ from, to, exp }) => {
    const target = row(from, exp === "never" ? null : exp);
    const upgrade = resolveTierUpgrade(target, to, NOW);
    expect(tierUpgradeRegression(target, upgrade, cfg)).toEqual([]);
  });

  it("keeps a manual extension that outlives the new tier default", () => {
    const extended = "2029-04-29T00:00:00.000Z";
    const upgrade = resolveTierUpgrade(row("episodic", extended), "semantic", NOW);
    expect(upgrade.tier).toBe("semantic");
    expect(upgrade.expires_at).toBe(extended);
  });

  it("returns metadata complete, with the trace uncloberrable", () => {
    // The caller's additions go in as an argument; the trace is written after
    // them, so there is no spread order for a caller to get wrong and no way
    // for an addition to overwrite the trace.
    const upgrade = resolveTierUpgrade(
      { ...row("semantic", null), metadata: { existing: 1 } },
      "procedural",
      NOW,
      { merge_count: 3, tier_upgraded_from: "LIES" },
    );
    expect(upgrade.metadata.existing).toBe(1);
    expect(upgrade.metadata.merge_count).toBe(3);
    expect(upgrade.metadata.tier_upgraded_from).toBe("semantic");
    expect(upgrade.metadata.tier_upgraded_to).toBe("procedural");
  });

  it("adds no trace when the tier does not move", () => {
    const upgrade = resolveTierUpgrade(row("semantic", null), "episodic", NOW, {
      merge_count: 1,
    });
    expect(upgrade.tier).toBe("semantic");
    expect(upgrade.metadata.merge_count).toBe(1);
    expect(upgrade.metadata.tier_upgraded_from).toBeUndefined();
  });
});

describe("create and upgrade agree on expiry", () => {
  /**
   * 0.2.4 added a path where an incoming write upgrades an existing row rather
   * than creating one. Creation derived expiry from `now`, the upgrade from
   * `target.created_at` — so identical input landed with different lifetimes
   * depending on whether it happened to collide. Measured against a 20-day-old
   * row: 10 days if it collided, 30 if it did not, with the colliding write
   * being the one carrying more evidence of relevance.
   */
  it.each(MEMORY_TIERS)(
    "gives %s the same expiry whether it creates or is absorbed",
    (tier) => {
      const created = expiryForWrite(tier, NOW);
      // An existing row of the same tier, 20 days old, whose expiry was set
      // from its own creation date.
      const agedRow = row(
        tier,
        expiryForWrite(tier, new Date(Date.parse(NOW) - 20 * 86_400_000).toISOString()),
      );
      const upgraded = resolveTierUpgrade(agedRow, tier, NOW);
      expect(upgraded.expires_at).toBe(created);
    },
  );

  it("extends expiry on re-assertion rather than leaving it to run out", () => {
    const old = expiryForWrite(
      "episodic",
      new Date(Date.parse(NOW) - 20 * 86_400_000).toISOString(),
    );
    const extended = expiryForWrite("episodic", NOW, old);
    expect(Date.parse(extended!)).toBeGreaterThan(Date.parse(old!));
  });

  it("still refuses to shorten a hand-extended expiry", () => {
    const far = "2099-01-01T00:00:00.000Z";
    expect(expiryForWrite("episodic", NOW, far)).toBe(far);
  });

  it("keeps never-expires as never", () => {
    expect(expiryForWrite("procedural", NOW)).toBeNull();
    expect(expiryForWrite("episodic", NOW, null)).toBeNull();
  });
});

describe("capHeadroom is deliberately outside effectiveLifetime", () => {
  it("reports pressure the per-row lifetime cannot see", () => {
    // The honest gap: an upgrade into a tier at its cap raises nominal
    // lifetime while lowering survival probability. Cap risk is population
    // dependent and rank based, so it is exposed separately rather than
    // folded into a per-row number.
    const full = capHeadroom("semantic", cfg.consolidation.caps.semantic, cfg);
    expect(full.headroom).toBe(0);
    expect(full.protected).toBe(false);

    const roomy = capHeadroom("episodic", 10, cfg);
    expect(roomy.headroom).toBeGreaterThan(0);

    // Procedural is exempt while evict_procedural is false, which is why the
    // case that actually bites is episodic -> semantic, not anything -> skill.
    const proc = capHeadroom("procedural", 9999, cfg);
    expect(proc.protected).toBe(true);
  });
});
