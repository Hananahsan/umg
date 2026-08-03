import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../lib/useReducedMotion";

/**
 * Count a number up on mount. Deterministic: driven by elapsed time against a
 * fixed duration and easing, so the same value always produces the same run
 * and a re-recorded replay looks identical.
 */
export function useCountUp(target: number, durationMs = 900): number {
  const reduced = useReducedMotion();
  const [value, setValue] = useState(reduced ? target : 0);
  const frame = useRef(0);

  useEffect(() => {
    if (reduced || durationMs <= 0) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const tick = (nowMs: number): void => {
      const t = Math.min(1, (nowMs - start) / durationMs);
      // easeOutExpo — fast commit, gentle settle; reads well at video speed.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
      setValue(Math.round(target * eased));
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    // Backstop: hidden tabs suspend requestAnimationFrame, which would leave
    // the headline number frozen at 0. Timers still fire, so the true value
    // always lands even if the count-up never runs.
    const settle = setTimeout(() => setValue(target), durationMs + 100);

    return () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(settle);
    };
  }, [target, durationMs, reduced]);

  return value;
}
