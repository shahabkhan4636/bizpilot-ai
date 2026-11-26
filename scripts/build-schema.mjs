#!/usr/bin/env node
/**
 * Regenerates the consolidated schema snapshot from the migration files.
 *
 *   sql/schema.sqlite.sql  =  every sql/migrations/*.up.sql, in order
 *
 * The snapshot is what a fresh database gets (zero-config dev, docker-compose,
 * `BIZPILOT_PG_SCHEMA=1`); the migrations are what an existing database gets.
 * Generating one from the other means they cannot drift, which is the usual way
 * "migrations" and "schema.sql" end up disagreeing.
 *
 *   node scripts/build-schema.mjs           # write
 *   node scripts/build-schema.mjs --check   # fail if out of date (CI)
 */
import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "sql", "migrations");
/**
 * For a FRESH database the snapshot can use the SQLite-flavoured variant of any
 * engine-specific migration: a table rebuild is valid on both engines when no RLS
 * policies exist yet (policies are applied afterwards by sql/rls.postgres.sql).
 * Existing databases go through the runner, which picks the file per engine.
 */
const bases = [...new Set(
  fs.readdirSync(dir)
    .filter((f) => /\.up\.(sql|postgres\.sql|sqlite\.sql)$/.test(f))
    .map((f) => f.replace(/\.up\.(postgres|sqlite)?\.?sql$/, ""))
)].sort();

const files = bases.map((base) => {
  const sqlite = `${base}.up.sqlite.sql`;
  return fs.existsSync(path.join(dir, sqlite)) ? sqlite : `${base}.up.sql`;
});

const header = `-- BizPilot AI — consolidated schema snapshot (GENERATED FILE)
-- Source of truth: sql/migrations/*.up.sql. Regenerate with: npm run db:schema
-- ${files.length} migration(s): ${files.join(", ")}
--
-- Portable SQL: this exact file is applied to SQLite and to PostgreSQL, so the
-- two deployments cannot diverge. Tenant isolation is enforced in application
-- queries (organization_id) and, on Postgres, by sql/rls.postgres.sql.

`;

const body = files
  .map((f) => `-- ===== ${f} =====\n${fs.readFileSync(path.join(dir, f), "utf8").trim()}\n`)
  .join("\n");
const next = header + body;
const target = path.join(process.cwd(), "sql", "schema.sqlite.sql");
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";

if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error("✖ sql/schema.sqlite.sql is out of date. Run: node scripts/build-schema.mjs");
    process.exit(1);
  }
  console.log(`✔ schema snapshot matches ${files.length} migrations`);
} else {
  fs.writeFileSync(target, next);
  console.log(`✔ wrote sql/schema.sqlite.sql from ${files.length} migration(s)`);
}
