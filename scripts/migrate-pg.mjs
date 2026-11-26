#!/usr/bin/env node
/**
 * Applies the portable schema, the plan seed and the RLS policies to DATABASE_URL.
 *
 *   DATABASE_URL=postgres://… node scripts/migrate-pg.mjs
 *
 * Safe to run repeatedly: every statement is `create … if not exists` or
 * `create or replace` / `drop policy if exists` + `create policy`.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✖ DATABASE_URL is not set.");
  process.exit(1);
}

const root = process.cwd();
const files = ["schema.sqlite.sql", "seed_plans.sql", "rls.postgres.sql"];

const client = new pg.Client({ connectionString: url });
await client.connect();

const { rows: meta } = await client.query("select current_database() as db, current_user as who, version()");
console.log(`→ ${meta[0].db} as ${meta[0].who}`);
console.log(`  ${meta[0].version.split(",")[0]}`);

for (const file of files) {
  const sql = fs.readFileSync(path.join(root, "sql", file), "utf8");
  try {
    await client.query(sql);
    console.log(`✔ applied ${file}`);
  } catch (error) {
    console.error(`✖ ${file}: ${error.message}`);
    await client.end();
    process.exit(1);
  }
}

const { rows: counts } = await client.query(`
  select
    (select count(*)::int from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as tables,
    (select count(*)::int from pg_tables where schemaname='public' and rowsecurity) as tables_with_rls,
    (select count(*)::int from pg_policies where schemaname='public') as policies,
    (select count(*)::int from plans) as plans
`);
console.log(
  `✔ ${counts[0].tables} tables · ${counts[0].tables_with_rls} with RLS · ${counts[0].policies} policies · ${counts[0].plans} plans`
);
console.log("\nNext: node scripts/seed.mjs --postgres --demo   (creates a login)");

await client.end();
