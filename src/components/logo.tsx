interface LogoProps {
  /** Rendered width in px; height follows the 180:150 mark aspect ratio. */
  size?: number;
  /**
   * `default` — green bubble, white سهل, Tint FLOW. For light/neutral
   * surfaces. `reversed` — white bubble, Primary-green text throughout.
   * For use on green or dark surfaces where the default mark would
   * disappear into the background.
   */
  variant?: "default" | "reversed";
  className?: string;
}

// Below this width the FLOW wordmark stops being legible, so it's
// dropped and سهل is rescaled to fill the bubble on its own.
const COMPACT_BREAKPOINT = 40;

export function Logo({ size = 32, variant = "default", className }: LogoProps) {
  const compact = size < COMPACT_BREAKPOINT;
  const bubbleFill = variant === "reversed" ? "#FFFFFF" : "#128C4A";
  const sahlFill = variant === "reversed" ? "#128C4A" : "#FFFFFF";
  const flowFill = variant === "reversed" ? "#128C4A" : "#A8E6C3";

  return (
    <svg
      viewBox="0 0 180 150"
      width={size}
      height={(size * 150) / 180}
      className={className}
      role="img"
      aria-label="Sahl Flow"
    >
      <path
        d="M34 8h112a26 26 0 0 1 26 26v54a26 26 0 0 1-26 26H62l-30 28 4-28h-2A26 26 0 0 1 8 88V34A26 26 0 0 1 34 8Z"
        fill={bubbleFill}
      />
      {compact ? (
        <text
          x="90"
          y="82"
          textAnchor="middle"
          fontFamily="Tajawal, sans-serif"
          fontSize="64"
          fontWeight="800"
          fill={sahlFill}
        >
          سهل
        </text>
      ) : (
        <>
          <text
            x="90"
            y="66"
            textAnchor="middle"
            fontFamily="Tajawal, sans-serif"
            fontSize="46"
            fontWeight="800"
            fill={sahlFill}
          >
            سهل
          </text>
          <text
            x="90"
            y="98"
            textAnchor="middle"
            fontFamily="Tajawal, sans-serif"
            fontSize="20"
            fontWeight="500"
            letterSpacing="5"
            fill={flowFill}
          >
            FLOW
          </text>
        </>
      )}
    </svg>
  );
}
