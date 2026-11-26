#!/usr/bin/env node
/**
 * The gate set from docs/DEFINITION-OF-DONE.md, in one command.
 *
 *   npm run verify          # types, lint, unit tests, schema snapshot, build
 *   npm run verify -- --e2e # also the Playwright suite (slow, needs a port)
 *
 * Each step runs to completion; the summary prints pass/fail per step and the
 * exit code is non-zero if any step failed, so CI can gate on it directly.
 */
import { spawnSync } from "node:child_process";

const withE2e = process.argv.includes("--e2e");
const steps = [
  { name: "typecheck", cmd: "npx tsc --noEmit" },
  { name: "lint", cmd: "npx eslint ." },
  { name: "unit tests", cmd: "npx vitest run" },
  { name: "schema snapshot", cmd: "node scripts/build-schema.mjs --check" },
  { name: "build", cmd: "npm run build" },
  ...(withE2e ? [{ name: "e2e", cmd: "npx playwright test" }] : []),
];

const results = [];
for (const step of steps) {
  process.stdout.write(`\n▶ ${step.name}\n`);
  const started = Date.now();
  const run = spawnSync(step.cmd, { shell: true, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  results.push({ ...step, ok: run.status === 0, seconds });
  if (run.status !== 0) break; // no point building after a type error
}

console.log("\n─── verify ───────────────────────────────");
for (const r of results) {
  console.log(`${r.ok ? "✔" : "✖"} ${r.name.padEnd(16)} ${r.seconds}s`);
}
const skipped = steps.slice(results.length);
for (const s of skipped) console.log(`· ${s.name.padEnd(16)} skipped (earlier failure)`);
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "\nall gates green" : `\n${failed.length} gate(s) failed`);
process.exit(failed.length === 0 && skipped.length === 0 ? 0 : 1);
