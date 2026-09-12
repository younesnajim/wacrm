"use client";

import { useState, useTransition } from "react";
import { Check, Languages, Moon, SunMoon, Sun } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { useTheme } from "@/hooks/use-theme";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n/locale";
import { setLocale } from "@/i18n/set-locale";
import { MODES, type Mode } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { SettingsPanelHead } from "./settings-panel-head";

/** Native endonyms — shown as-is regardless of the current UI locale. */
const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
};

/**
 * Appearance panel — light/dark mode + accent-color picker.
 *
 * Two independent controls: a mode toggle (light / dark) and the
 * accent grid. Either applies + persists immediately. No save button:
 * each change is a single attribute swap on <html>, there's nothing
 * to roll back.
 *
 * Persistence: localStorage only (device-scoped). The boot script in
 * layout.tsx replays both choices before first paint on subsequent
 * loads.
 */
export function AppearancePanel() {
  const { mode, setMode } = useTheme();
  const t = useTranslations("Settings.appearance");

  return (
    <section className="max-w-3xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t("title")}
        description={t("description")}
      />

      <div className="space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <SunMoon className="size-4 text-muted-foreground" />
          {t("mode")}
        </h3>

        <div
          role="radiogroup"
          aria-label="Color mode"
          className="grid max-w-md grid-cols-2 gap-3"
        >
          {MODES.map((m) => (
            <ModeCard
              key={m}
              mode={m}
              isActive={m === mode}
              onPick={() => setMode(m)}
            />
          ))}
        </div>
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Languages className="size-4 text-muted-foreground" />
          {t("language")}
        </h3>

        <div
          role="radiogroup"
          aria-label={t("language")}
          className="grid max-w-md grid-cols-2 gap-3"
        >
          {SUPPORTED_LOCALES.map((code) => (
            <LanguageCard key={code} code={code} />
          ))}
        </div>
      </div>
    </section>
  );
}

function LanguageCard({ code }: { code: Locale }) {
  const locale = useLocale();
  const t = useTranslations("Settings.appearance");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingCode, setPendingCode] = useState<Locale | null>(null);
  const isActive = code === locale;
  const name = LOCALE_NAMES[code];

  function onPick() {
    if (isActive || isPending) return;
    setPendingCode(code);
    startTransition(async () => {
      await setLocale(code);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={t("useLanguage", { name })}
      disabled={isPending}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span className="flex-1 text-sm font-semibold text-foreground">{name}</span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-tint-foreground">
          <Check className="h-3 w-3" />
          {t("active")}
        </span>
      )}
      {isPending && pendingCode === code && (
        <span className="text-[11px] text-muted-foreground">…</span>
      )}
    </button>
  );
}

function ModeCard({
  mode,
  isActive,
  onPick,
}: {
  mode: Mode;
  isActive: boolean;
  onPick: () => void;
}) {
  const t = useTranslations("Settings.appearance");
  const isLight = mode === "light";
  const Icon = isLight ? Sun : Moon;
  return (
    <button
      type="button"
      role="radio"
      onClick={onPick}
      aria-checked={isActive}
      aria-label={t("useMode", { mode })}
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-card p-4 text-start transition-colors",
        isActive
          ? "border-primary/60 ring-2 ring-primary/40"
          : "border-border hover:border-border hover:bg-muted/40",
      )}
    >
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="flex-1 text-sm font-semibold capitalize text-foreground">
        {mode}
      </span>
      {isActive && (
        <span className="inline-flex items-center gap-1 rounded-full bg-tint px-2 py-0.5 text-[11px] font-medium text-tint-foreground">
          <Check className="h-3 w-3" />
          {t("active")}
        </span>
      )}
    </button>
  );
}
