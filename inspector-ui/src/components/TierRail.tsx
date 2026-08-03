import {
  TIER_BLURB,
  TIER_COLOR,
  formatHalfLife,
  type TierOverview,
} from "../api";
import { Bar } from "./Bar";

interface Props {
  tier: TierOverview;
  index: number;
}

/**
 * One tier as a capacity rail. The prune replay animates these same rails,
 * so tier colour, geometry and the cap tick are defined once here.
 */
export function TierRail({ tier, index }: Props): React.JSX.Element {
  const color = TIER_COLOR[tier.tier];

  // When over cap the track stretches to fit the overflow, so the cap tick
  // slides left and the spill is visibly outside the budget.
  const span = Math.max(tier.active, tier.cap, 1);
  const capPct = (tier.cap / span) * 100;
  const withinCapPct = (Math.min(tier.active, tier.cap) / span) * 100;
  const overflowPct = (tier.over_by / span) * 100;

  const overCap = tier.over_by > 0;
  // Procedural over cap is reported, never evicted — colouring it "danger"
  // would claim something the engine will not do.
  const overflowColor = tier.protected ? color : "var(--color-op-evict)";
  // Sequenced by duration, not delay: all rails start together and settle in
  // order, so no bar is ever waiting in a collapsed state. See Bar.tsx.
  const duration = 620 + 130 * index;

  return (
    <div className="border-b border-line px-6 py-5 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="flex items-baseline gap-3">
          <span
            aria-hidden
            className="inline-block size-2 shrink-0 translate-y-px rounded-full"
            style={{ background: color, boxShadow: `0 0 10px ${color}` }}
          />
          <h2
            className="text-sm font-semibold tracking-[0.16em] uppercase"
            style={{ color }}
          >
            {tier.tier}
          </h2>
          <span className="hidden text-xs text-faint sm:inline">
            {TIER_BLURB[tier.tier]}
          </span>
        </div>

        <div className="flex items-baseline gap-4 text-xs">
          <span className="text-faint">
            t½{" "}
            <span className="text-muted">{formatHalfLife(tier.half_life_days)}</span>
          </span>
          <span className="tabular-nums">
            <span className="text-base font-semibold text-text">{tier.active}</span>
            <span className="text-faint"> / {tier.cap}</span>
          </span>
        </div>
      </div>

      <div
        className="relative mt-3 h-2.5 overflow-hidden rounded-[3px] bg-ink-inset ring-1 ring-line"
        role="img"
        aria-label={`${tier.tier}: ${tier.active} active of ${tier.cap} cap`}
      >
        <Bar
          leftPct={0}
          widthPct={withinCapPct}
          color={color}
          opacity={0.9}
          durationMs={duration}
        />

        {overCap && (
          <>
            <Bar
              leftPct={capPct}
              widthPct={overflowPct}
              color={overflowColor}
              hatched
              durationMs={duration + 280}
            />
            <span
              aria-hidden
              className="absolute inset-y-0 w-px bg-white/70"
              style={{ left: `${capPct}%` }}
            />
          </>
        )}

        {/* Instrument graticule — reads as a gauge rather than a progress bar. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), rgba(0,0,0,0.45) calc(10% - 1px) 10%)",
          }}
        />
      </div>

      <div className="mt-2 flex min-h-4 items-center gap-3 text-[11px]">
        {overCap && tier.protected && (
          <span style={{ color }}>
            {tier.over_by} over cap · protected, never evicted
          </span>
        )}
        {overCap && !tier.protected && (
          <span style={{ color: "var(--color-op-evict)" }}>
            {tier.over_by} over cap · lowest decay evicted first
          </span>
        )}
        {!overCap && tier.health === "filling" && (
          <span className="text-muted">
            {tier.cap - tier.active} slots before cap pressure
          </span>
        )}
        {!overCap && tier.health === "empty" && (
          <span className="text-faint">empty</span>
        )}
      </div>
    </div>
  );
}
