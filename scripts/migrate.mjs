#!/usr/bin/env node
/**
 * Database migration / bootstrap.
 *
 *   node scripts/migrate.mjs            apply the SQLite dev schema + plan seed
 *   node scripts/migrate.mjs --status   report what exists without changing anything
 *
 * Production (Supabase Postgres) migrations are applied with psql or the Supabase
 * SQL editor — see README → "Switching to Supabase". This script never touches
 * Postgres, so it can never silently "migrate" the wrong database.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = process.cwd();
const dbFile = process.env.BIZPILOT_DB_FILE ?? path.join(root, "data", "bizpilot.db");
const statusOnly = process.argv.includes("--status");

const schemaPath = path.join(root, "sql", "schema.sqlite.sql");
const seedPath = path.join(root, "sql", "seed_plans.sql");

for (const file of [schemaPath, seedPath]) {
  if (!fs.existsSync(file)) {
    console.error(`✖ missing ${path.relative(root, file)}`);
    process.exit(1);
  }
}

fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function tableNames() {
  return db
    .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
    .all()
    .map((r) => r.name);
}

if (statusOnly) {
  const tables = tableNames();
  console.log(`Database: ${dbFile}`);
  console.log(`Engine  : SQLite (development / demo)`);
  console.log(`Tables  : ${tables.length}`);
  for (const t of tables) {
    const { c } = db.prepare(`select count(*) as c from ${t}`).get();
    console.log(`  - ${t.padEnd(24)} ${c} row(s)`);
  }
  if (tables.includes("plans")) {
    for (const p of db.prepare("select code, price_monthly_cents, lead_limit from plans order by sort_order").all()) {
      console.log(`  plan: ${p.code.padEnd(14)} $${(p.price_monthly_cents / 100).toFixed(2)}/mo · ${p.lead_limit} leads`);
    }
  }
  db.close();
  process.exit(0);
}

const before = tableNames();
console.log(`Applying ${path.relative(root, schemaPath)} …`);
db.exec(fs.readFileSync(schemaPath, "utf8"));
console.log(`Seeding  ${path.relative(root, seedPath)} …`);
db.exec(fs.readFileSync(seedPath, "utf8"));

const after = tableNames();
const created = after.filter((t) => !before.includes(t));
console.log(`✔ Schema ready at ${dbFile}`);
console.log(`  ${after.length} tables${created.length ? ` (${created.length} new: ${created.join(", ")})` : " (all already existed)"}`);

const plans = db.prepare("select code, name, price_monthly_cents, price_annual_cents, lead_limit from plans order by sort_order").all();
console.log("  Plans:");
for (const p of plans) {
  console.log(`    ${p.code.padEnd(14)} ${p.name.padEnd(14)} $${(p.price_monthly_cents / 100).toFixed(2)}/mo  $${(p.price_annual_cents / 100).toFixed(2)}/yr  ${p.lead_limit} leads`);
}
db.close();
console.log("\nNext: npm run seed   (creates your first account)");
