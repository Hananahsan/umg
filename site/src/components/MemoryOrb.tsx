import { ThinkingOrb } from "thinking-orbs";

/**
 * thinking-orbs "searching": scan meridian over a dotted globe.
 * Used only where recall / memory search is the subject.
 *
 * @see https://github.com/Jakubantalik/thinking-orbs
 */
type Props = {
  size?: 20 | 64;
  theme?: "light" | "dark" | "auto";
  className?: string;
  label?: string;
  /** Default slow: baked globe scan is fast; 0.4 keeps it calm. */
  speed?: number;
};

export default function MemoryOrb({
  size = 64,
  theme = "light",
  className,
  label = "Recalling memory…",
  speed = 0.4,
}: Props) {
  return (
    <ThinkingOrb
      state="searching"
      size={size}
      theme={theme}
      speed={speed}
      aria-label={label}
      className={className}
    />
  );
}
