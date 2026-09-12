/**
 * MODE — the light/dark dimension.
 *
 * The CSS variables live in `src/app/globals.css` under
 * `html[data-mode="..."]` blocks. Applied at runtime via
 * `document.documentElement.dataset.mode`. Dark is the historical
 * default and stays the app's identity; light is the opt-in
 * eye-strain-friendly alternative.
 *
 * Sahl Flow ships one fixed brand palette — there is no accent
 * picker. The brand tokens (--primary, --tint, --amber, --ink, …)
 * live directly in globals.css and aren't user-selectable.
 */
export const MODES = ["light", "dark"] as const;

export type Mode = (typeof MODES)[number];

export const DEFAULT_MODE: Mode = "dark";

export const MODE_STORAGE_KEY = "wacrm.mode";

export function isMode(value: unknown): value is Mode {
  return (
    typeof value === "string" && (MODES as ReadonlyArray<string>).includes(value)
  );
}
