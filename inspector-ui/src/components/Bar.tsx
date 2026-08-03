import { useEntrance } from "../lib/useEntrance";

interface Props {
  /** Offset from the left of the track, as a percentage. */
  leftPct: number;
  /** Segment width, as a percentage. */
  widthPct: number;
  color: string;
  /** Diagonal hatch, used to mark quantity that is over a cap. */
  hatched?: boolean;
  /** Sequencing is done with duration, never delay — see the note below. */
  durationMs?: number;
  opacity?: number;
}

/**
 * One segment of a capacity rail.
 *
 * The entrance is a pure CSS keyframe declaring only a `from` state, with no
 * delay and no fill-mode, attached only when the document is visible (see
 * useEntrance). The element's own resting transform is the identity, so the
 * bar draws correctly whenever the animation is absent or has finished.
 *
 * Three earlier versions got this wrong, each by making the drawn result
 * depend on something running: motion's initial/animate left late-mounted
 * segments stuck at scaleX(0); a requestAnimationFrame version left every
 * segment at zero while the tab was hidden; and an animation-delay with
 * `backwards` fill pinned bars at scaleX(0) through a delay that never
 * elapsed. Hence sequencing by duration rather than delay, and gating on
 * visibility rather than assuming the animation will progress.
 *
 * Only transform is animated; width and left are static.
 */
export function Bar({
  leftPct,
  widthPct,
  color,
  hatched,
  durationMs = 700,
  opacity = 1,
}: Props): React.JSX.Element {
  const entrance = useEntrance();
  return (
    <div
      className={`absolute inset-y-0 origin-left${entrance ? " bar-grow" : ""}`}
      style={
        {
          left: `${leftPct}%`,
          width: `${widthPct}%`,
          backgroundColor: color,
          backgroundImage: hatched
            ? "repeating-linear-gradient(115deg, rgba(0,0,0,0.34) 0 3px, transparent 3px 7px)"
            : undefined,
          opacity,
          "--bar-duration": `${durationMs}ms`,
        } as React.CSSProperties
      }
    />
  );
}
