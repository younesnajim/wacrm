import { describe, expect, it } from "vitest";
import {
  buildContactsCsv,
  contactsExportFilename,
  type ExportableContactRow,
} from "./export-contacts-csv";

function row(overrides: Partial<ExportableContactRow> = {}): ExportableContactRow {
  return {
    name: "Jane Doe",
    phone: "+15551234567",
    email: "jane@example.com",
    company: "Acme Corp",
    tagNames: [],
    created_at: "2026-09-13T10:15:00.000Z",
    ...overrides,
  };
}

describe("buildContactsCsv", () => {
  it("starts with a UTF-8 BOM", () => {
    const csv = buildContactsCsv([row()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("writes the header row", () => {
    const csv = buildContactsCsv([]);
    const [header] = csv.slice(1).split("\r\n");
    expect(header).toBe("Name,Phone,Email,Company,Tags,Created Date");
  });

  it("writes a plain row without quoting", () => {
    const csv = buildContactsCsv([row()]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toBe(
      "Jane Doe,+15551234567,jane@example.com,Acme Corp,,2026-09-13",
    );
  });

  it("joins tags into one comma-separated cell, itself quoted", () => {
    const csv = buildContactsCsv([row({ tagNames: ["VIP", "Newsletter"] })]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toContain('"VIP, Newsletter"');
  });

  it("quotes a field containing a comma", () => {
    const csv = buildContactsCsv([row({ company: "Acme, Inc." })]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toContain('"Acme, Inc."');
  });

  it("doubles up internal quotes", () => {
    const csv = buildContactsCsv([row({ name: 'The "Big" Deal' })]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toContain('"The ""Big"" Deal"');
  });

  it("renders missing optional fields as empty cells, not the string 'null'", () => {
    const csv = buildContactsCsv([
      row({ name: null, email: null, company: null }),
    ]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toBe(",+15551234567,,,,2026-09-13");
  });

  it("truncates the timestamp to a plain calendar date", () => {
    const csv = buildContactsCsv([row({ created_at: "2026-01-05T23:59:59.999Z" })]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[1]).toContain("2026-01-05");
    expect(lines[1]).not.toContain("T");
  });

  it("writes one line per row, in the given order", () => {
    const csv = buildContactsCsv([
      row({ phone: "+1" }),
      row({ phone: "+2" }),
      row({ phone: "+3" }),
    ]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[1]).toContain("+1");
    expect(lines[2]).toContain("+2");
    expect(lines[3]).toContain("+3");
  });
});

describe("contactsExportFilename", () => {
  it("formats as contacts-YYYY-MM-DD.csv", () => {
    expect(contactsExportFilename(new Date(2026, 8, 13))).toBe(
      "contacts-2026-09-13.csv",
    );
  });

  it("zero-pads single-digit months and days", () => {
    expect(contactsExportFilename(new Date(2026, 0, 5))).toBe(
      "contacts-2026-01-05.csv",
    );
  });
});
