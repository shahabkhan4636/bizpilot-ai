import { describe, it, expect } from "vitest";
import { cn, formatMoney, slugify, percent, addDays, relativeTime } from "@/lib/utils";
import { passwordProblems, hashPassword, verifyPassword } from "@/lib/password";
import { parseCsv, toCsv, mapImportRows, LEAD_STATUSES } from "@/lib/csv";
import { renderPdf } from "@/lib/pdf";
import { ruleBasedLeadScore, buildContentPrompt, AI_KINDS } from "@/lib/ai";
import { verifyStripeSignature } from "@/lib/stripe";
import { createHmac } from "node:crypto";

describe("utils", () => {
  it("joins class names", () => {
    expect(cn("a", false && "b", "c")).toBe("a c");
  });
  it("formats money", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(0)).toBe("$0.00");
  });
  it("slugifies", () => {
    expect(slugify("Vertex Interiors & Co.")).toBe("vertex-interiors-co");
  });
  it("computes percentages without dividing by zero", () => {
    expect(percent(5, 10)).toBe(50);
    expect(percent(1, 0)).toBe(0);
  });
  it("adds days", () => {
    const base = new Date("2026-01-01T00:00:00.000Z");
    expect(addDays(14, base).toISOString().slice(0, 10)).toBe("2026-01-15");
  });
  it("renders relative time in human units", () => {
    expect(relativeTime(new Date(Date.now() - 5_000).toISOString())).toBe("just now");
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
    expect(relativeTime(new Date(Date.now() - 3 * 3600_000).toISOString())).toBe("3h ago");
    expect(relativeTime(null)).toBe("—");
  });
});

describe("passwords", () => {
  it("rejects weak passwords with specific reasons", () => {
    expect(passwordProblems("short")).not.toHaveLength(0);
    expect(passwordProblems("alllettersonly")).not.toHaveLength(0);
  });
  it("accepts a reasonable password", () => {
    expect(passwordProblems("correcthorse42")).toHaveLength(0);
  });
  it("hashes and verifies without storing plaintext", async () => {
    const hash = await hashPassword("correcthorse42");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("correcthorse42");
    expect(await verifyPassword("correcthorse42", hash)).toBe(true);
    expect(await verifyPassword("wrong-password1", hash)).toBe(false);
    expect(await verifyPassword("correcthorse42", null)).toBe(false);
  });
  it("produces a different hash for the same password (unique salt)", async () => {
    const a = await hashPassword("correcthorse42");
    const b = await hashPassword("correcthorse42");
    expect(a).not.toBe(b);
  });
});

describe("csv", () => {
  it("parses quoted fields with commas and newlines", () => {
    const rows = parseCsv('name,notes\n"Doe, Jane","line1\nline2"');
    expect(rows[1]![0]).toBe("Doe, Jane");
    expect(rows[1]![1]).toBe("line1\nline2");
  });
  it("round-trips through toCsv", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'q"z']]);
    const back = parseCsv(csv);
    expect(back[1]![0]).toBe("x,y");
    expect(back[1]![1]).toBe('q"z');
  });
  it("drops completely blank lines during parsing", () => {
    expect(parseCsv("name,email\nSara,sara@x.com\n,,\nBilal,bilal@y.com")).toHaveLength(3);
  });
  it("skips rows that have neither a name nor an email", () => {
    // The middle row carries only unrelated data, so it is counted as skipped rather than imported.
    const { rows, skipped } = mapImportRows(parseCsv("name,email,company\nSara,sara@x.com,Vertex\n,,Orphan Co\nBilal,bilal@y.com,Vext"));
    expect(rows).toHaveLength(2);
    expect(skipped).toBe(1);
    expect(rows[0]!.email).toBe("sara@x.com");
    expect(rows[1]!.company).toBe("Vext");
  });
  it("defaults the source when missing", () => {
    const { rows } = mapImportRows(parseCsv("name\nSara"));
    expect(rows[0]!.source).toBe("import");
  });
  it("exposes the seven pipeline statuses", () => {
    expect(LEAD_STATUSES).toHaveLength(7);
  });
});

describe("pdf", () => {
  it("produces a parseable multi-page PDF", () => {
    const bytes = renderPdf([
      { text: "Proposal", size: 18, bold: true, rule: true },
      ...Array.from({ length: 90 }, (_, i) => ({ text: `Line ${i} of body text` })),
      { text: "Total: $46.00", align: "right" },
    ]);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(text).toContain("/Count 2");
    expect(text).toContain("Total: $46.00");
    expect(text).toContain("startxref");
  });
  it("escapes parentheses so the file stays valid", () => {
    const text = Buffer.from(renderPdf([{ text: "Deposit (50%) due" }])).toString("latin1");
    expect(text).toContain("Deposit \\(50%\\) due");
  });
});

describe("lead scoring", () => {
  it("scores a referral with a valid email higher than a cold import", () => {
    const referral = ruleBasedLeadScore({ name: "A", email: "a@b.com", source: "referral", value_cents: 500000, phone: "123" });
    const cold = ruleBasedLeadScore({ name: "B", source: "cold" });
    expect(referral.score).toBeGreaterThan(cold.score);
    expect(referral.method).toBe("rules");
    expect(referral.reason.length).toBeGreaterThan(10);
    expect(referral.nextAction.length).toBeGreaterThan(5);
  });
  it("keeps scores inside 0-100", () => {
    for (const source of ["referral", "website", "cold", "import", "unknown"]) {
      const s = ruleBasedLeadScore({ name: "X", email: "x@y.com", phone: "1", source, value_cents: 9_000_000, notes: "a".repeat(200) });
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });
  it("builds a prompt that forbids invented facts", () => {
    const { system, prompt } = buildContentPrompt({
      kind: "sales_email", businessName: "Acme", services: "SEO", tone: "friendly",
      language: "English", objective: "book a call", customerName: "Sara",
    });
    expect(system.toLowerCase()).toContain("never invent");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain("book a call");
  });
  it("supports nine content kinds", () => {
    expect(AI_KINDS).toHaveLength(9);
  });
});

describe("stripe webhook signatures", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

  it("accepts a correctly signed payload", () => {
    const result = verifyStripeSignature(body, `t=${t},v1=${sig}`, secret);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.id).toBe("evt_1");
  });
  it("rejects a tampered body", () => {
    const result = verifyStripeSignature(body.replace("evt_1", "evt_2"), `t=${t},v1=${sig}`, secret);
    expect(result.ok).toBe(false);
  });
  it("rejects a wrong secret", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other").ok).toBe(false);
  });
  it("rejects an old timestamp (replay)", () => {
    const old = t - 4000;
    const oldSig = createHmac("sha256", secret).update(`${old}.${body}`).digest("hex");
    const result = verifyStripeSignature(body, `t=${old},v1=${oldSig}`, secret);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.toLowerCase()).toContain("tolerance");
  });
  it("rejects a missing header", () => {
    expect(verifyStripeSignature(body, null, secret).ok).toBe(false);
  });
});
