"use client";

import { useTransition } from "react";
import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { SUPPORTED_LOCALES, type Locale } from "@/i18n/locale";
import { setLocale } from "@/i18n/set-locale";
import { cn } from "@/lib/utils";

/** Native endonyms — always shown as-is, regardless of the current UI locale. */
const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ar: "العربية",
};

const LOCALE_CODES: Record<Locale, string> = {
  en: "EN",
  ar: "AR",
};

/**
 * Header language toggle — same hit-target height and hover treatment
 * as ModeToggle next to it. With exactly two supported locales, one
 * click flips to the other; the label always names the *destination*
 * language by its own native name, mirroring ModeToggle's
 * "Switch to {mode} mode" pattern.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const locale = useLocale() as Locale;
  const t = useTranslations("LanguageToggle");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const next = SUPPORTED_LOCALES.find((code) => code !== locale) ?? locale;
  const switchLabel = t("switchLanguage", { name: LOCALE_NAMES[next] });

  function onClick() {
    if (isPending) return;
    startTransition(async () => {
      await setLocale(next);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isPending}
      aria-label={switchLabel}
      title={switchLabel}
      className={cn(
        "flex h-10 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50",
        className,
      )}
    >
      <Languages className="h-5 w-5" />
      <span className="text-xs font-semibold">{LOCALE_CODES[locale]}</span>
    </button>
  );
}
