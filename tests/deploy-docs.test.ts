import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Phase 6 — the deploy runbook and the smoke script must stay true.
 *
 * Documentation rots silently: someone adds `process.env.NEW_THING`, ships it, and the
 * deploy fails on a fresh project because nobody knew the variable existed. This test
 * makes that impossible — every environment variable the app reads must be documented,
 * and the smoke script's CLI must keep working.
 */

const ROOT = process.cwd();

/**
 * Variables that are deliberately NOT in `.env.example`: they are set by the tooling
 * itself, or exist only for tests. Listing them here is a decision, not an omission.
 */
const TOOLING_ONLY = new Set([
  "NODE_ENV", // set by Node/Next
  "VERCEL_URL", // set by Vercel
  "VERCEL_PROJECT_PRODUCTION_URL", // set by Vercel
  "BIZPILOT_DB_FILE", // documents itself in .env.example as commented dev-only
  "BIZPILOT_ENGINE",
  "BIZPILOT_PG_SCHEMA",
  "BIZPILOT_PG_WORKER",
  "MIGRATION_SKIP",
]);

function envNamesInCode(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(ROOT, "src"));

  const names = new Set<string>();
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

/** A variable counts as documented when its name appears as a line/assignment. */
function documents(file: string, name: string): boolean {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  return new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`).test(source);
}

describe("environment documentation", () => {
  const used = envNamesInCode();

  it("finds the variables the app actually reads", () => {
    expect(used.length).toBeGreaterThan(30);
    expect(used).toContain("DATABASE_URL");
    expect(used).toContain("ADMIN_EMAIL");
    expect(used).toContain("CRON_SECRET");
  });

  it("documents every one of them in .env.example or DEPLOY-ADMIN.md", () => {
    const undocumented = used.filter(
      (name) => !TOOLING_ONLY.has(name) && !documents(".env.example", name) && !documents("DEPLOY-ADMIN.md", name)
    );
    expect(undocumented, `undocumented env vars: ${undocumented.join(", ")}`).toEqual([]);
  });

  it("keeps the tooling-only allowlist honest (no dead entries)", () => {
    // Everything in the allowlist should still be referenced somewhere in src or scripts.
    const scripts = fs.readdirSync(path.join(ROOT, "scripts")).map((file) => fs.readFileSync(path.join(ROOT, "scripts", file), "utf8")).join("\n");
    const src = used.join("\n");
    for (const name of TOOLING_ONLY) {
      const referenced = src.includes(name) || scripts.includes(name);
      expect(referenced, `${name} is in the allowlist but nothing uses it`).toBe(true);
    }
  });
});

describe("DEPLOY-ADMIN.md", () => {
  const doc = fs.readFileSync(path.join(ROOT, "DEPLOY-ADMIN.md"), "utf8");

  it("covers the owner-critical steps in order", () => {
    const required = [
      "Session pooler", // the IPv4 problem
      "DATABASE_URL",
      "SESSION_SECRET",
      "ADMIN_EMAIL",
      "CRON_SECRET",
      "RESEND_API_KEY",
      "node scripts/db-migrate.mjs --status",
      "node scripts/smoke.mjs",
      "/admin/platform-payments",
      "/admin/workspaces",
      "IMPERSONATE",
      "rollback",
    ];
    const missing = required.filter((needle) => !doc.toLowerCase().includes(needle.toLowerCase()));
    expect(missing, `missing from DEPLOY-ADMIN.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("states what is blocked instead of pretending everything ships", () => {
    expect(doc).toMatch(/not possible/i);
    expect(doc).toMatch(/merchant account/i);
    expect(doc).toMatch(/Vercel Pro/i);
  });

  it("does not contain a real wallet number, IBAN or API key", () => {
    // The whole point of the platform-settings table is that these never reach source.
    expect(doc).not.toMatch(/03\d{9}/); // Pakistani mobile wallets
    expect(doc).not.toMatch(/PK\d{2}[A-Z]{4}\d{16}/); // IBAN
    expect(doc).not.toMatch(/re_[A-Za-z0-9]{16,}/); // Resend key
    expect(doc).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{16,}/); // Stripe key
  });
});

describe("scripts/smoke.mjs", () => {
  it("lists its checks without touching the network", () => {
    const output = execFileSync("node", ["scripts/smoke.mjs", "--list"], { cwd: ROOT, encoding: "utf8" });
    for (const id of ["marketing", "login", "csp", "readiness", "admin-gate", "cron-email", "webhook-closed"]) {
      expect(output).toContain(id);
    }
    expect(output).toMatch(/\d+ checks/);
  });

  it("exits 2 (usage) when no URL is given, so CI cannot mistake it for a pass", () => {
    let code = 0;
    try {
      execFileSync("node", ["scripts/smoke.mjs"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ADMIN_LIVE_URL: "" } });
    } catch (error) {
      code = (error as { status?: number }).status ?? 0;
    }
    expect(code).toBe(2);
  });

  it("is wired into package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.smoke).toBe("node scripts/smoke.mjs");
  });
});
