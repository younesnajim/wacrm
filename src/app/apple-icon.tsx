import { ImageResponse } from "next/og";

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

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#128C4A",
        }}
      >
        <div
          style={{
            width: 155,
            height: 155,
            borderRadius: 34,
            background: "#FFFFFF",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              display: "flex",
              fontFamily: "Tajawal",
              fontWeight: 800,
              fontSize: 61,
              lineHeight: 1,
              color: "#128C4A",
            }}
          >
            سهل
          </span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [{ name: "Tajawal", data: tajawal, weight: 800, style: "normal" }],
    },
  );
}
