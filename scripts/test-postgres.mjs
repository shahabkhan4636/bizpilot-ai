#!/usr/bin/env node
/**
 * The whole gate, against real PostgreSQL.
 *
 *   DATABASE_URL=postgres://… npm run test:postgres
 *
 * Runs: typecheck → lint → migrate → unit/integration/webhook/RLS suites →
 * production build → the 15-test browser suite, all against the same database.
 * Fails on the first red step, like CI should.
 */
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✖ DATABASE_URL is not set. This script exists to test the Postgres engine.");
  process.exit(1);
}

const env = {
  ...process.env,
  BIZPILOT_ENGINE: "postgres",
  DATABASE_URL: url,
  // The live RLS suite needs a non-owner role; reuse the URL if no anon role is given.
  RLS_LIVE_URL: process.env.RLS_LIVE_URL ?? "",
  ADMIN_LIVE_URL: process.env.ADMIN_LIVE_URL ?? url,
};

const steps = [
  ["typecheck", "npx tsc --noEmit"],
  ["lint", "npx eslint ."],
  ["migrate", "node scripts/migrate-pg.mjs"],
  ["vitest", "npx vitest run"],
  ["build", "npx next build"],
  ["playwright", "npx playwright test"],
];

const results = [];
for (const [name, command] of steps) {
  console.log(`\n=== ${name} ===`);
  try {
    execSync(command, { stdio: "inherit", env });
    results.push([name, "pass"]);
  } catch {
    results.push([name, "FAIL"]);
    console.error(`\n✖ ${name} failed — stopping here.`);
    break;
  }
}

console.log("\n=== summary (PostgreSQL) ===");
for (const [name, status] of results) console.log(`  ${status === "pass" ? "✔" : "✖"} ${name}`);
process.exit(results.every(([, s]) => s === "pass") ? 0 : 1);
