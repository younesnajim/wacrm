/**
 * Locale is user-switchable (see `Settings.appearance`), not fixed per
 * install. `DEFAULT_LOCALE` only decides what a visitor with no cookie
 * yet sees — it's read once at module load, matching how every other
 * `NEXT_PUBLIC_*` env var behaves in this app.
 */

export const SUPPORTED_LOCALES = ['en', 'ar'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function isSupportedLocale(value: string | undefined | null): value is Locale {
  return !!value && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

const envLocale = process.env.NEXT_PUBLIC_APP_LOCALE;
export const DEFAULT_LOCALE: Locale = isSupportedLocale(envLocale) ? envLocale : 'en';

/** Cookie the user's locale choice is persisted to. Readable client-side (not httpOnly) so client components can reflect it without a round trip. */
export const LOCALE_COOKIE = 'wacrm.locale';
