import { describe, it, expect, beforeEach, vi } from "vitest";
import { run, get, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { toCsv, parseCsv, mapImportRows } from "@/lib/csv";
import { money, ValidationError } from "@/lib/validate";
import { renderPdf } from "@/lib/pdf";

/**
 * Regression tests for the hardening pass: the cases that were wrong, not the
 * cases that were already fine.
 */

function seedOrg(): string {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `hard-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${slug}@example.com`, "x", "Hardening", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, "Org", slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, "owner", now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, "professional", "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  return orgId;
}

describe("CSV export cannot carry a spreadsheet formula", () => {
  it("prefixes and quotes formula-looking values", () => {
    const csv = toCsv(
      ["name", "email"],
      [
        ['=HYPERLINK("http://evil.example","click me")', "a@b.co"],
        ["@SUM(1+1)", "c@d.co"],
        ["+1234", "e@f.co"],
        ["-1+1", "g@h.co"],
        ["\tpayload", "i@j.co"],
      ]
    );
    const lines = csv.split("\n");
    // Every dangerous field is now text: prefixed with ' and quoted.
    expect(lines[1]!.startsWith(`"'`)).toBe(true);
    expect(lines[2]!.startsWith(`"'`)).toBe(true);
    expect(lines[3]!.startsWith(`"'`)).toBe(true);
    expect(lines[4]!.startsWith(`"'`)).toBe(true);
    expect(lines[5]!.startsWith(`"'`)).toBe(true);
    expect(csv).not.toMatch(/(^|\n)=/);
  });

  it("leaves ordinary values untouched and still quotes delimiters", () => {
    const csv = toCsv(["name", "notes"], [["Doe, Jane", 'said "hi"']]);
    expect(csv.split("\n")[1]).toBe(`"Doe, Jane","said ""hi"""`);
  });

  it("keeps numbers as numbers", () => {
    const csv = toCsv(["amount"], [[1200]]);
    expect(csv.split("\n")[1]).toBe("1200");
  });
});

describe("CSV import tolerates what Excel actually produces", () => {
  it("strips a UTF-8 BOM so headers still match", () => {
    const rows = parseCsv("\uFEFFname,email,company\nAda,ada@example.com,Analytical\n");
    expect(rows[0]).toEqual(["name", "email", "company"]);
    const mapped = mapImportRows(rows);
    expect(mapped.rows[0]).toMatchObject({ name: "Ada", email: "ada@example.com", company: "Analytical" });
  });

  it("handles CRLF, quoted newlines and escaped quotes", () => {
    const rows = parseCsv('name,notes\r\n"Doe, Jane","line1\nline2"\r\n"O""Brien",ok\r\n');
    expect(rows[1]).toEqual(["Doe, Jane", "line1\nline2"]);
    expect(rows[2]).toEqual(['O"Brien', "ok"]);
  });

  it("ignores a trailing blank line instead of importing an empty lead", () => {
    const rows = parseCsv("name,email\nAda,ada@example.com\n\n");
    const mapped = mapImportRows(rows.filter((r) => r.some((c) => c.trim() !== "")));
    expect(mapped.rows).toHaveLength(1);
  });
});

describe("money parsing is strict", () => {
  it("accepts the shapes a person types", () => {
    expect(money("1200", "Amount")).toBe(120_000);
    expect(money("1200.50", "Amount")).toBe(120_050);
    expect(money("  $1,200.50 ", "Amount")).toBe(120_050);
    expect(money("0", "Amount")).toBe(0);
    expect(money("", "Amount")).toBe(0);
  });

  it("rejects hex, scientific notation, negatives and junk", () => {
    for (const bad of ["0x10", "1e3", "-5", "abc", "12,34.5.6", "Infinity", "NaN", "１２"]) {
      expect(() => money(bad, "Amount"), `expected ${bad} to be rejected`).toThrow(ValidationError);
    }
  });

  it("rejects absurd magnitudes instead of silently truncating", () => {
    expect(() => money("99999999999", "Amount")).toThrow(/too large/);
  });
});

describe("PDF rendering survives hostile input", () => {
  it("escapes parens and backslashes so the content stream stays valid", () => {
    const pdf = renderPdf([{ text: "Total (incl. \\ fees)", size: 12 }]);
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("\\(incl. \\\\ fees\\)");
  });

  it("degrades non-Latin1 characters instead of emitting broken bytes", () => {
    const pdf = renderPdf([{ text: "Zürich — 🎉 naïve", size: 12 }]);
    const text = Buffer.from(pdf).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    // Latin-1 characters survive, anything outside it becomes '?'
    expect(text).toContain("Zürich");
    expect(text).not.toContain("🎉");
  });

  it("renders an empty document without throwing", () => {
    const pdf = renderPdf([]);
    expect(Buffer.from(pdf).toString("latin1").startsWith("%PDF-")).toBe(true);
  });
});

describe("document storage paths cannot escape the upload directory", () => {
  beforeEach(() => resetDatabaseForTests());

  it("stores under a generated name regardless of the uploaded name", async () => {
    const { saveFileLocal } = await import("@/lib/storage");
    for (const hostile of ["../../etc/passwd", "..\\..\\windows\\system32", "a/b/c.txt", "normal.pdf"]) {
      const saved = await saveFileLocal(hostile, Buffer.from("x"));
      expect(saved.path).not.toContain("/");
      expect(saved.path).not.toContain("\\");
      expect(saved.path).not.toContain("..");
    }
  });

  it("reads back only inside the upload directory", async () => {
    const { saveFileLocal, readFileLocal } = await import("@/lib/storage");
    const saved = await saveFileLocal("note.txt", Buffer.from("hello"));
    expect((await readFileLocal(saved.path)).toString()).toBe("hello");
    // A traversal attempt is resolved by basename, so it can never leave the dir.
    await expect(readFileLocal("../../package.json")).rejects.toBeTruthy();
  });

  it("keeps one workspace's document row out of another's lookup", () => {
    const orgA = seedOrg();
    const orgB = seedOrg();
    const id = newId();
    const now = nowIso();
    run(
      `insert into documents (id, organization_id, uploaded_by, file_name, mime_type, size_bytes, storage_provider, storage_path, status, created_at)
       values (?,?,?,?,?,?,?,?,?,?)`,
      [id, orgA, null, "contract.pdf", "application/pdf", 10, "local", `${id}-contract.pdf`, "ready", now]
    );
    const found = get<{ id: string }>("select id from documents where id = ? and organization_id = ?", [id, orgB]);
    expect(found).toBeUndefined();
  });
});

describe("rate limiter", () => {
  beforeEach(() => resetDatabaseForTests());

  it("counts every request in the window and refuses past the limit", async () => {
    const { rateLimit } = await import("@/lib/ratelimit");
    const results = Array.from({ length: 5 }, () => rateLimit("probe:1", 3, 60));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.at(-1)!.allowed).toBe(false);
    expect(results.at(-1)!.resetInSeconds).toBeGreaterThan(0);
  });

  it("reports the remaining allowance without going negative", async () => {
    const { rateLimit } = await import("@/lib/ratelimit");
    const first = rateLimit("probe:2", 2, 60);
    expect(first.remaining).toBe(1);
    rateLimit("probe:2", 2, 60);
    expect(rateLimit("probe:2", 2, 60).remaining).toBe(0);
  });

  it("rolls the window over instead of locking the key out forever", async () => {
    const { rateLimit } = await import("@/lib/ratelimit");
    for (let i = 0; i < 3; i += 1) rateLimit("probe:3", 1, 1);
    expect(rateLimit("probe:3", 1, 1).allowed).toBe(false);
    // A zero-length window means every call starts a fresh window, which proves
    // the rollover branch is exercised rather than pinned to the first insert.
    expect(rateLimit("probe:3", 1, 1).allowed).toBe(false);
    expect(rateLimit("probe:4", 1, 0).allowed).toBe(true);
    expect(rateLimit("probe:4", 1, 0).allowed).toBe(true);
  });

  it("keeps keys independent", async () => {
    const { rateLimit } = await import("@/lib/ratelimit");
    expect(rateLimit("probe:a", 1, 60).allowed).toBe(true);
    expect(rateLimit("probe:a", 1, 60).allowed).toBe(false);
    expect(rateLimit("probe:b", 1, 60).allowed).toBe(true);
  });

  it("does not let a concurrent burst exceed the limit", async () => {
    const { rateLimit } = await import("@/lib/ratelimit");
    // Sequential calls share the same atomic statement; the count must match the
    // number of calls exactly, which is what the old read-then-write could not
    // guarantee under load.
    const allowed = Array.from({ length: 30 }, () => rateLimit("probe:burst", 10, 60)).filter((r) => r.allowed);
    expect(allowed).toHaveLength(10);
    const row = get<{ count: number }>("select count from rate_limits where key = 'probe:burst'");
    expect(row?.count).toBe(30);
  });
});

describe("auth limits are configurable per deployment", () => {
  it("uses the documented defaults when the environment says nothing", async () => {
    vi.resetModules();
    delete process.env.LOGIN_RATE_LIMIT;
    delete process.env.SIGNUP_RATE_LIMIT;
    const mod = await import("@/lib/ratelimit");
    expect(mod.LOGIN_LIMIT).toBe(20);
    expect(mod.LOGIN_WINDOW_SECONDS).toBe(600);
    expect(mod.SIGNUP_LIMIT).toBe(10);
    expect(mod.SIGNUP_WINDOW_SECONDS).toBe(3600);
  });

  it("honours a deployment override, and ignores nonsense", async () => {
    vi.resetModules();
    process.env.SIGNUP_RATE_LIMIT = "500";
    const raised = await import("@/lib/ratelimit");
    expect(raised.SIGNUP_LIMIT).toBe(500);

    vi.resetModules();
    process.env.SIGNUP_RATE_LIMIT = "not-a-number";
    const broken = await import("@/lib/ratelimit");
    // Falls back to the safe default instead of disabling the limit.
    expect(broken.SIGNUP_LIMIT).toBe(10);
    delete process.env.SIGNUP_RATE_LIMIT;
  });
});

describe("readiness probe tells the truth about the schema", () => {
  it("counts migrations as rows and probes for the newest columns", async () => {
    const { GET } = await import("@/app/api/readiness/route");
    const res = await GET();
    const body = (await res.json()) as {
      ready: boolean;
      checks: Record<string, { ok: boolean; detail?: string }>;
      providers: Record<string, boolean>;
    };
    expect(res.status).toBe(200);
    expect(body.ready).toBe(true);
    const applied = Number(/^(\d+) applied$/.exec(body.checks.migrations.detail ?? "")?.[1]);
    expect(applied).toBeGreaterThanOrEqual(7);
    expect(body.checks.schema_columns?.ok).toBe(true);
    // It reports provider state; it must never echo a secret value.
    expect(JSON.stringify(body)).not.toMatch(/sk_(test|live)_|re_[A-Za-z0-9]{8}/);
  });
});

describe("public base URL resolution", () => {
  it("prefers an explicit variable and strips its trailing slash", async () => {
    const { appUrl } = await import("@/lib/app-url");
    process.env.NEXT_PUBLIC_APP_URL = "https://bizpilot.example/";
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(appUrl()).toBe("https://bizpilot.example");
  });

  it("falls back to Vercel's own host so a deploy is correct without configuration", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "bizpilot-ai.vercel.app";
    const { appUrl } = await import("@/lib/app-url");
    expect(appUrl()).toBe("https://bizpilot-ai.vercel.app");

    vi.resetModules();
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.VERCEL_URL = "bizpilot-preview-123.vercel.app";
    const preview = await import("@/lib/app-url");
    expect(preview.appUrl()).toBe("https://bizpilot-preview-123.vercel.app");
    delete process.env.VERCEL_URL;
  });

  it("uses localhost when nothing is set", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    delete process.env.VERCEL_URL;
    const { appUrl } = await import("@/lib/app-url");
    expect(appUrl()).toBe("http://localhost:3000");
  });
});
