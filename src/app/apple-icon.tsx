import { ImageResponse } from "next/og";
import { BrandMarkSquare } from "@/lib/brand-mark";

// Same mark as icon.tsx at the standard Apple touch-icon size. No
// outer corner radius — iOS applies its own rounded-square mask, so
// drawing one here would double up.

export const runtime = "edge";
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  const tajawal = await fetch(
    new URL("./fonts/Tajawal-ExtraBold.ttf", import.meta.url),
  ).then((res) => res.arrayBuffer());

  return new ImageResponse(<BrandMarkSquare size={180} groundRadius={0} />, {
    ...size,
    fonts: [{ name: "Tajawal", data: tajawal, weight: 800, style: "normal" }],
  });
}
