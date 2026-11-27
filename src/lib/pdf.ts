/**
 * Minimal PDF writer — no dependencies, no headless browser.
 *
 * Produces a standards-compliant PDF 1.4 file (uncompressed content streams,
 * standard Helvetica fonts, ASCII escaping) with automatic page breaks.
 * It is deliberately small: text lines, sizes, spacing and simple horizontal rules.
 */

export type PdfLine = {
  text: string;
  /** font size in points */
  size?: number;
  bold?: boolean;
  /** gap in points after this line */
  gap?: number;
  rule?: boolean;
  align?: "left" | "right";
};

const PAGE_W = 595.28; // A4 in points
const PAGE_H = 841.89;
const MARGIN = 56;
const LINE_FACTOR = 1.32;

function escapeText(input: string): string {
  // PDF strings are Latin-1; degrade anything else to '?' so the file stays valid.
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .split("")
    .map((ch) => (ch.charCodeAt(0) > 255 ? "?" : ch))
    .join("");
}

function textWidth(text: string, size: number, bold: boolean): number {
  // Approximate Helvetica advance widths (avg 0.52 em regular, 0.55 em bold).
  return text.length * size * (bold ? 0.55 : 0.52);
}

function buildPages(lines: PdfLine[]): string[] {
  const pages: string[] = [];
  let ops: string[] = [];
  let y = PAGE_H - MARGIN;

  const flush = () => {
    if (ops.length) pages.push(ops.join("\n"));
    ops = [];
    y = PAGE_H - MARGIN;
  };

  for (const line of lines) {
    const size = line.size ?? 10;
    const bold = Boolean(line.bold);
    const lead = size * LINE_FACTOR;
    if (y - lead < MARGIN) flush();
    y -= lead;

    if (line.text) {
      const lines = wrap(line.text, size, bold);
      for (const [i, piece] of lines.entries()) {
        if (y - lead < MARGIN) flush();
        if (i > 0) y -= lead;
        const w = textWidth(piece, size, bold);
        const x = line.align === "right" ? PAGE_W - MARGIN - w : MARGIN;
        ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapeText(piece)}) Tj ET`);
      }
    }

    if (line.rule) {
      ops.push(`0.75 w 0.6 0.6 0.6 RG ${MARGIN} ${(y - 4).toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${(y - 4).toFixed(2)} l S`);
      y -= 8;
    }

    y -= line.gap ?? 0;
  }
  flush();
  return pages.length ? pages : [""];
}

function wrap(text: string, size: number, bold: boolean): string[] {
  const maxWidth = PAGE_W - MARGIN * 2;
  if (textWidth(text, size, bold) <= maxWidth) return [text];
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size, bold) > maxWidth && current) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Returns a complete PDF file as a Uint8Array. */
export function renderPdf(lines: PdfLine[]): Uint8Array {
  const pageStreams = buildPages(lines);
  const objects: string[] = [];

  const pageObjNumbers: number[] = [];
  // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, then (page, content) pairs.
  let next = 5;
  for (let i = 0; i < pageStreams.length; i++) {
    pageObjNumbers.push(next);
    next += 2;
  }

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageStreams.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  pageStreams.forEach((stream, i) => {
    const pageNum = pageObjNumbers[i]!;
    const contentNum = pageNum + 1;
    objects[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, "latin1");
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(pdf, "latin1");
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    pdf += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

