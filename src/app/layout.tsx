import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import localFont from "next/font/local";
import Script from "next/script";
import "./globals.css";
import { getDirection } from "@/lib/i18n/direction";
import { ThemeProvider } from "@/hooks/use-theme";
import { ThemedToaster } from "@/components/themed-toaster";
import {
  DEFAULT_MODE,
  MODE_STORAGE_KEY,
  MODES,
} from "@/lib/themes";

// Self-hosted (next/font/local) rather than next/font/google — the
// Google loader fetches these from fonts.gstatic.com at *build* time,
// and Turbopack has no retry/offline path for that: a single network
// hiccup fails every route under this layout ("Module not found:
// @vercel/turbopack-next/internal/font/google/font"). Self-hosting
// removes the build-time network dependency entirely.
//
// One family for both scripts — Tajawal, the Sahl Flow brand font,
// used for Arabic and Latin alike (no separate Latin face; a phone
// number or URL inside Arabic UI just renders in Tajawal's own Latin
// glyphs). Three weights only: 400 body, 500 subheads, 800 headings.
//
// Files are the unsplit source TTFs from the google/fonts GitHub repo
// (github.com/google/fonts/tree/main/ofl/tajawal), converted to
// woff2, one file per weight — NOT the per-subset (arabic/latin)
// woff2 files fonts.gstatic.com serves, since next/font/local's `src`
// array has no per-file `unicode-range` option: two same-weight files
// there would become fallback *sources* for one face (the browser
// uses whichever loads first for every glyph) rather than a correct
// script-based split. The unsplit source file sidesteps that
// entirely: full Arabic + Latin glyph coverage in one file per
// weight, exactly like Google's own subsetting would render when
// both scripts appear together (which they always do here — phone
// numbers, template variables, and URLs still show up inside Arabic
// UI).
const tajawal = localFont({
  src: [
    { path: "./fonts/Tajawal-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Tajawal-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Tajawal-800.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "wacrm",
    template: "%s — wacrm",
  },
  description: "Self-hostable CRM template for WhatsApp.",
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: [{ url: "/icon" }],
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#0e1a14",
  colorScheme: "dark light",
};

// Inline boot script — runs before React hydrates so the user's
// chosen mode (data-mode) is on the <html> element before first
// paint. Without this every page load flashes the server-rendered
// default for a frame before the React tree mounts and applies the
// picked value.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the MODES constant so adding one doesn't silently
// break the boot path.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var MODE_DEFAULT = ${JSON.stringify(DEFAULT_MODE)};
    var MODES = ${JSON.stringify(MODES)};
    var savedMode = localStorage.getItem(MODE_KEY);
    d.dataset.mode = MODES.indexOf(savedMode) !== -1 ? savedMode : MODE_DEFAULT;
  } catch (_e) {
    d.dataset.mode = ${JSON.stringify(DEFAULT_MODE)};
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = getDirection(locale);

  return (
    <html
      lang={locale}
      dir={dir}
      data-mode={DEFAULT_MODE}
      className={`${tajawal.variable} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-mode` on <html>
      // from localStorage before React hydrates, so for a non-default
      // choice the client DOM intentionally differs from the
      // server-rendered default. suppressHydrationWarning silences the
      // expected mismatch — it only applies to this element's own
      // attributes, so genuine mismatches in children still surface.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider>
            {children}
            <ThemedToaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
