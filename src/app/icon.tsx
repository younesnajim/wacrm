import { ImageResponse } from "next/og";
import { BrandMarkSquare } from "@/lib/brand-mark";

// Sahl Flow app icon — green ground, white bubble (tail included),
// سهل only (no FLOW line — illegible at favicon size). Geometry lives
// in src/lib/brand-mark.tsx, shared with apple-icon.tsx.
//
// Satori (next/og's renderer) can't parse WOFF2 — see the font-loading
// comment in `src/app/layout.tsx` for the woff2 story — so this route
// fetches the raw Tajawal ExtraBold TTF instead of reusing the woff2
// files next/font/local loads for the rest of the app.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  const tajawal = await fetch(
    new URL("./fonts/Tajawal-ExtraBold.ttf", import.meta.url),
  ).then((res) => res.arrayBuffer());

  return new ImageResponse(<BrandMarkSquare size={32} groundRadius={6} />, {
    ...size,
    fonts: [{ name: "Tajawal", data: tajawal, weight: 800, style: "normal" }],
  });
}
