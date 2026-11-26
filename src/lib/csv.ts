/** RFC-4180-ish CSV parse/serialise with quoted-field support. */

export function parseCsv(input: string): string[][] {
  const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = (value: string | number | null | undefined): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
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
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
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
