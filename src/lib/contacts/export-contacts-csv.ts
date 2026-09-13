/**
 * CSV generation for the contacts export button. Mirrors
 * parse-contact-csv.ts's column set (phone/name/email/company/tags)
 * plus a created-date column, since export and import should agree on
 * what a "contact row" looks like.
 */

export interface ExportableContactRow {
  name?: string | null;
  phone: string;
  email?: string | null;
  company?: string | null;
  /** Tag names, already resolved from tag ids — this module doesn't
   *  know about the tags table. */
  tagNames: string[];
  created_at: string;
}

const CSV_HEADERS = ['Name', 'Phone', 'Email', 'Company', 'Tags', 'Created Date'];

/** RFC 4180 field escaping — quote (and double up internal quotes)
 *  only when the value actually needs it, so plain fields stay clean. */
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** ISO calendar date only (no time) — stable for sorting/reimport
 *  regardless of the viewer's locale, unlike a localized date string. */
function formatCreatedDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Builds the full CSV text, UTF-8 BOM included so Excel auto-detects
 * the encoding instead of guessing a codepage that mangles Arabic (or
 * any non-ASCII) names.
 */
export function buildContactsCsv(rows: ExportableContactRow[]): string {
  const lines = [CSV_HEADERS.join(',')];

  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.name ?? ''),
        csvEscape(row.phone),
        csvEscape(row.email ?? ''),
        csvEscape(row.company ?? ''),
        csvEscape(row.tagNames.join(', ')),
        csvEscape(formatCreatedDate(row.created_at)),
      ].join(','),
    );
  }

  const BOM = String.fromCharCode(0xfeff);
  return BOM + lines.join('\r\n');
}

/** `contacts-YYYY-MM-DD.csv`, from the local calendar date. */
export function contactsExportFilename(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `contacts-${y}-${m}-${d}.csv`;
}
