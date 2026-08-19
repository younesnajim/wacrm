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
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  MODES,
  STORAGE_KEY,
  THEME_IDS,
} from "@/lib/themes";

// Self-hosted (next/font/local) rather than next/font/google — the
// Google loader fetches these from fonts.gstatic.com at *build* time,
// and Turbopack has no retry/offline path for that: a single network
// hiccup fails every route under this layout ("Module not found:
// @vercel/turbopack-next/internal/font/google/font"). Self-hosting
// removes the build-time network dependency entirely.
//
// Files were pulled from Google's own sources (not hand-picked
// substitutes) so rendering is unchanged:
//   - Inter: the variable-weight latin woff2 straight from
//     fonts.gstatic.com (the same file next/font/google would have
//     used for `subsets: ["latin"]`, no weight restriction).
//   - Tajawal: the unsplit source TTFs from the google/fonts GitHub
//     repo (github.com/google/fonts/tree/main/ofl/tajawal), converted
//     to woff2, one file per weight. NOT the per-subset (arabic/latin)
//     woff2 files fonts.gstatic.com serves — next/font/local's `src`
//     array has no per-file `unicode-range` option, so two same-weight
//     files there become fallback *sources* for one face (the browser
//     uses whichever loads first for every glyph) rather than a
//     correct script-based split. The unsplit source file sidesteps
//     that entirely: full Arabic + Latin glyph coverage in one file
//     per weight, exactly like Google's own subsetting would render
//     when both scripts appear together (which they always do here —
//     phone numbers, template variables, and URLs still show up
//     inside Arabic UI).
const inter = localFont({
  src: "./fonts/Inter-latin-variable.woff2",
  variable: "--font-sans",
  weight: "100 900",
  display: "swap",
});

// Arabic UI face. Loaded only for RTL locales so LTR installs don't pay
// for the extra font files. Falls through to Inter for Latin glyphs that
// still appear in an Arabic UI (phone numbers, template variables, URLs).
const tajawal = localFont({
  src: [
    { path: "./fonts/Tajawal-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Tajawal-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Tajawal-700.woff2", weight: "700", style: "normal" },
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
  themeColor: "#020617",
  colorScheme: "dark light",
};

// Inline boot script — runs before React hydrates so the user's
// chosen accent (data-theme) AND mode (data-mode) are on the <html>
// element before first paint. Without this every page load flashes
// the server-rendered defaults for a frame before the React tree
// mounts and applies the picked values.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the THEME_IDS / MODES constants so adding one doesn't
// silently break the boot path.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var THEME_KEY = ${JSON.stringify(STORAGE_KEY)};
    var THEME_DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    var THEMES = ${JSON.stringify(THEME_IDS)};
    var savedTheme = localStorage.getItem(THEME_KEY);
    d.dataset.theme = THEMES.indexOf(savedTheme) !== -1 ? savedTheme : THEME_DEFAULT;

    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var MODE_DEFAULT = ${JSON.stringify(DEFAULT_MODE)};
    var MODES = ${JSON.stringify(MODES)};
    var savedMode = localStorage.getItem(MODE_KEY);
    d.dataset.mode = MODES.indexOf(savedMode) !== -1 ? savedMode : MODE_DEFAULT;
  } catch (_e) {
    d.dataset.theme = ${JSON.stringify(DEFAULT_THEME)};
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
  const font = dir === "rtl" ? tajawal : inter;

  return (
    <html
      lang={locale}
      dir={dir}
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className={`${font.variable} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-theme` and
      // `data-mode` on <html> from localStorage before React hydrates,
      // so for any non-default choice the client DOM intentionally
      // differs from the server-rendered defaults. suppressHydration-
      // Warning silences the expected mismatch — it only applies to
      // this element's own attributes, so genuine mismatches in
      // children still surface.
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
