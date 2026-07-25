import { ThinkingOrb } from "thinking-orbs";

/**
 * Brand mark: thinking-orbs "working" (particles on orbits).
 * Reads as a thought/agent mind — calm, continuous, not a loading spinner.
 * Slow motion keeps it logo-like rather than busy.
 *
 * @see https://github.com/Jakubantalik/thinking-orbs
 */
type Props = {
  /** 20 fits wordmark row; 64 only if a large lockup is needed */
  size?: 20 | 64;
  /** light page → dark ink; dark band/footer on image → light ink */
  theme?: "light" | "dark";
  className?: string;
};

export default function BrandLogo({
  size = 20,
  theme = "light",
  className,
}: Props) {
  return (
    <ThinkingOrb
      state="working"
      size={size}
      theme={theme}
      speed={0.28}
      aria-label="umg0"
      className={className}
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}
