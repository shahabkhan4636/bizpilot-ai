/** RFC-4180-ish CSV parse/serialise with quoted-field support. */

export function parseCsv(input: string): string[][] {
  // Excel writes UTF-8 with a BOM. Left in place it becomes part of the first
  // header name ("\ufeffname"), so every column match silently fails and the
  // importer falls back to positional guessing.
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Escapes one CSV field.
 *
 * Two separate problems, both real:
 *  1. Delimiters/quotes/newlines need RFC 4180 quoting.
 *  2. A field starting with `=`, `+`, `-`, `@`, TAB or CR is a *formula* to Excel,
 *     Sheets and LibreOffice. A lead called `=HYPERLINK("http://evil","click")`
 *     would execute when the customer opens their export, so those values are
 *     prefixed with an apostrophe and quoted, which spreadsheets treat as text.
 */
function escapeCsvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  const looksLikeFormula = /^[=+\-@\t\r]/.test(s);
  const body = looksLikeFormula ? `'${s}` : s;
  return looksLikeFormula || /[",\n]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = escapeCsvField;
  const lines = [headers.map(escape).join(",")];
  for (const r of rows) lines.push(r.map(escape).join(","));
  return lines.join("\n");
}

export const LEAD_IMPORT_HEADERS = ["name", "email", "phone", "company", "source", "status", "value", "notes"] as const;
export type LeadImportRow = {
  name: string;
  email: string;
  phone: string;
  company: string;
  source: string;
  status: string;
  value: string;
  notes: string;
};

export const LEAD_STATUSES = ["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal_sent: "Proposal Sent",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export function mapImportRows(rows: string[][]): { rows: LeadImportRow[]; skipped: number; headers: string[] } {
  if (rows.length === 0) return { rows: [], skipped: 0, headers: [] };
  const headers = rows[0]!.map((h) => h.replace(/^\uFEFF/, "").trim().toLowerCase());
  const hasHeader = headers.some((h) => ["name", "email", "company"].includes(h));
  const body = hasHeader ? rows.slice(1) : rows;
  const idx = (key: string) => headers.indexOf(key);

  const out: LeadImportRow[] = [];
  let skipped = 0;
  for (const r of body) {
    const pick = (key: string, positional: number) => {
      const i = idx(key);
      if (i >= 0) return (r[i] ?? "").trim();
      return (r[positional] ?? "").trim();
    };
    const item: LeadImportRow = {
      name: pick("name", 0),
      email: pick("email", 1),
      phone: pick("phone", 2),
      company: pick("company", 3),
      source: pick("source", 4) || "import",
      status: pick("status", 5),
      value: pick("value", 6),
      notes: pick("notes", 7),
    };
    if (!item.name && !item.email) {
      skipped++;
      continue;
    }
    out.push(item);
  }
  return { rows: out, skipped, headers };
}
