/**
 * Text direction for a locale.
 *
 * The locale is user-switchable (see `src/i18n/locale.ts` and the
 * language switcher in Settings → Appearance), so this is resolved
 * per-request in the root layout and applied to <html dir>. Everything
 * downstream uses logical Tailwind utilities (ms-/me-/ps-/pe-/start-/
 * end-/text-start), so no component needs to know the direction itself.
 */

/** Locales written right-to-left. Base language subtag, lowercased. */
const RTL_LANGUAGES = new Set([
  'ar', // Arabic
  'fa', // Persian
  'he', // Hebrew
  'ur', // Urdu
  'ps', // Pashto
  'sd', // Sindhi
  'ug', // Uyghur
  'yi', // Yiddish
  'dv', // Divehi
  'ckb', // Central Kurdish
]);

export type Direction = 'ltr' | 'rtl';

/**
 * Resolve the direction for a locale tag. Accepts plain tags ('ar') and
 * region-qualified ones ('ar-AE', 'ar_SA') — only the language subtag
 * decides.
 */
export function getDirection(locale: string | undefined | null): Direction {
  if (!locale) return 'ltr';
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
}

/** True when the locale reads right-to-left. */
export function isRtl(locale: string | undefined | null): boolean {
  return getDirection(locale) === 'rtl';
}
