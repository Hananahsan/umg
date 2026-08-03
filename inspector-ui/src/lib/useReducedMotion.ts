import { useEffect, useState } from "react";

/**
 * Tracks prefers-reduced-motion, including changes made while the page is open.
 *
 * Deliberately hand-rolled rather than imported from `motion`: step 1 does not
 * otherwise need that library, and importing it here would pull ~100 kB into
 * the bundle that ships inside the npm tarball. The prune replay in step 3
 * does need it — that is when the cost gets paid.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent): void => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    setReduced(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

function query(): MediaQueryList | null {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  return window.matchMedia("(prefers-reduced-motion: reduce)");
}
