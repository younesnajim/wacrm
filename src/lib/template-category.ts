/**
 * Shared category metadata for WhatsApp message templates.
 *
 * Previously duplicated (and drifted slightly out of sync) between
 * the Settings template manager and the broadcast wizard's template
 * picker. One source of truth now.
 */

export const TEMPLATE_CATEGORIES = ["Marketing", "Utility", "Authentication"] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

const TEMPLATE_CATEGORY_CLASSES: Record<TemplateCategory, string> = {
  // Neutral slate — a template category, not a status or a brand
  // accent, so it doesn't compete with the real semantic colors below.
  Marketing: "bg-slate-500/10 text-muted-foreground border-slate-500/20",
  Utility: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Authentication: "bg-amber text-amber-foreground border-amber/30",
};

export function templateCategoryClass(category: string): string {
  return (
    TEMPLATE_CATEGORY_CLASSES[category as TemplateCategory] ??
    TEMPLATE_CATEGORY_CLASSES.Utility
  );
}
