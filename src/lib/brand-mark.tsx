// Shared geometry for the Sahl Flow bubble mark rendered via next/og
// (icon.tsx, apple-icon.tsx) — green ground, white bubble (tail
// included), سهل in green inside the bubble.
//
// The bubble is drawn at its native 180:150 aspect ratio, inset from
// the canvas edges by `PAD_FRAC` on each side and centered, so the
// tail stays fully on-canvas and سهل sits inside the bubble's
// rounded-rect area instead of overflowing it. These fractions were
// tuned by actually rendering the mark at 32/128/180/512px and
// checking each output for clipping — do not change them without
// re-rendering and looking, since satori/resvg (next/og's renderer)
// has no text-shaping preview and small errors only show up in the
// rasterized PNG, not in the JSX.

const BUBBLE_PATH =
  "M34 8h112a26 26 0 0 1 26 26v54a26 26 0 0 1-26 26H62l-30 28 4-28h-2A26 26 0 0 1 8 88V34A26 26 0 0 1 34 8Z";

const PAD_FRAC = 0.1;
const FONT_FRAC = 0.24;
// Fraction of the bubble artwork's own height where the rounded-rect
// (non-tail) portion is vertically centered — from the source SVG's
// viewBox (180x150), that rect spans y≈8..114, center y≈61.
const TEXT_CENTER_FRAC = 61 / 150;

export function BrandMarkSquare({
  size,
  groundRadius = 0,
}: {
  size: number;
  groundRadius?: number;
}) {
  const artWidth = size * (1 - 2 * PAD_FRAC);
  const artHeight = artWidth / 1.2; // source viewBox is 180:150
  const artLeft = (size - artWidth) / 2;
  const artTop = (size - artHeight) / 2;
  const textCenterY = artTop + TEXT_CENTER_FRAC * artHeight;
  const fontSize = size * FONT_FRAC;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: "#128C4A",
        borderRadius: groundRadius,
      }}
    >
      <svg
        viewBox="0 0 180 150"
        width={artWidth}
        height={artHeight}
        style={{ position: "absolute", left: artLeft, top: artTop }}
      >
        <path d={BUBBLE_PATH} fill="#FFFFFF" />
      </svg>
      <span
        style={{
          position: "absolute",
          left: 0,
          top: textCenterY - fontSize * 0.5,
          width: size,
          height: fontSize,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Tajawal",
          fontWeight: 800,
          fontSize,
          lineHeight: 1,
          color: "#128C4A",
        }}
      >
        سهل
      </span>
    </div>
  );
}
