import { useEffect, useState } from "react";

/**
 * Whether entrance animations should be attached at all.
 *
 * Browsers suspend animations in a hidden tab, and a suspended animation holds
 * its first keyframe indefinitely. Any entrance that starts from "not shown"
 * therefore renders as "never shown" while the tab is in the background — no
 * choice of property, fill-mode or delay avoids this, because the animation is
 * active but frozen at time zero.
 *
 * So the animation class is only applied once the document is visible. A page
 * that loads hidden paints its resting state immediately (correct, just
 * un-animated) and plays the reveal the moment it is brought forward.
 */
export function useEntrance(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );

  useEffect(() => {
    if (visible) return;
    const onChange = (): void => {
      if (document.visibilityState === "visible") setVisible(true);
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [visible]);

  return visible;
}
