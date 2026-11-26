import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { pgBridge, isPostgresEngine } from "./pg-sync";

/**
 * Data layer
 * ----------
 * Two engines behind one synchronous API:
 *
 *   • SQLite (better-sqlite3)  — default for local development and the demo.
 *   • PostgreSQL               — selected automatically when `DATABASE_URL` is set
 *                               (or `BIZPILOT_ENGINE=postgres`), using
 *                               `src/lib/pg-sync.ts`. The real connection lives in
 *                               `scripts/pg-worker.mjs`; the main thread blocks on
 *                               Atomics so `all/get/run/tx` stay synchronous and
 *                               all 300+ existing call sites keep working.
 *
 * `sql/schema.sqlite.sql` is deliberately portable SQL: it is applied verbatim to
 * both engines (no PRAGMA, no SQLite-only functions, no forward foreign-key
 * references), so the two deployments cannot drift.
 *
 * Tenant isolation in the running app is enforced by `organization_id` on every
 * query. Postgres additionally carries RLS policies (see `sql/rls.postgres.sql`)
 * for anything connecting with a non-owner role, e.g. a browser anon key.
 */

export type Row = Record<string, unknown>;
export type Params = unknown[];

const DB_DIR = path.join(process.cwd(), "data");
const DB_FILE = process.env.BIZPILOT_DB_FILE ?? path.join(DB_DIR, "bizpilot.db");

type GlobalCache = { __bizpilotDb?: Database.Database };
const g = globalThis as unknown as GlobalCache;

export function engineName(): "postgres" | "sqlite" {
  return isPostgresEngine() ? "postgres" : "sqlite";
}

function readSql(file: string): string {
  const p = path.join(process.cwd(), "sql", file);
  return fs.readFileSync(p, "utf8");
}

/**
 * A database created from the consolidated snapshot already contains every
 * migration's DDL, so mark them applied. Without this, `npm run db:migrate`
 * would try to re-add columns that already exist.
 */
function recordMigrationsAsApplied(database: Database.Database): void {
  try {
    const dir = path.join(process.cwd(), "sql", "migrations");
    if (!fs.existsSync(dir)) return;
    const ids = [
      ...new Set(
        fs
          .readdirSync(dir)
          .filter((f) => /\.up\.(sql|postgres\.sql|sqlite\.sql)$/.test(f))
          .map((f) => f.split("_")[0])
      ),
    ].sort();
    database.exec(
      "create table if not exists schema_migrations (id text primary key, name text not null, checksum text not null, applied_at text not null)"
    );
    const now = new Date().toISOString();
    const insert = database.prepare(
      "insert or ignore into schema_migrations (id, name, checksum, applied_at) values (?,?,?,?)"
    );
    for (const id of ids) {
      const row = database
        .prepare("select name from schema_migrations limit 1")
        .get() as { name?: string } | undefined;
      if (row?.name) continue; // already baselined
      insert.run(id, `${id}_snapshot`, "snapshot", now);
    }
  } catch {
    // Bookkeeping only: never block application startup because of it.
  }
}

const ALREADY_APPLIED = /duplicate column name|already exists|duplicate object/i;

function applySchemaIdempotently(database: Database.Database, sql: string): void {
  // Comment-only lines are stripped first: a leading `--` must not cause the
  // statement that follows it to be skipped.
  const statements = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const statement of statements) {
    try {
      database.exec(statement);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (ALREADY_APPLIED.test(message)) continue;
      throw new Error(`Schema statement failed: ${message}\n${statement.slice(0, 200)}`);
    }
  }
}

function initialise(): Database.Database {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const database = new Database(DB_FILE);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  // Applying the snapshot on every boot is what lets an existing database pick up
  // newly added tables without a manual step. `create table/index if not exists`
  // is idempotent, but `alter table … add column` (used by older migrations) is
  // not, so statements are applied one at a time and only "it is already there"
  // errors are ignored — anything else still fails loudly.
  applySchemaIdempotently(database, readSql("schema.sqlite.sql"));
  // Idempotent plan seed (upsert) so pricing can change without code edits.
  database.exec(readSql("seed_plans.sql"));
  recordMigrationsAsApplied(database);
  return database;
}

export function db(): Database.Database {
  if (!g.__bizpilotDb) g.__bizpilotDb = initialise();
  return g.__bizpilotDb;
}

/* ------------------------------------------------------------------ */
/* Query helpers — identical surface on both engines                   */
/* ------------------------------------------------------------------ */

export function all<T = Row>(sql: string, params: Params = []): T[] {
  if (isPostgresEngine()) return pgBridge().all<T>(sql, params);
  return db().prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, params: Params = []): T | undefined {
  if (isPostgresEngine()) return pgBridge().get<T>(sql, params);
  return db().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
  if (isPostgresEngine()) return pgBridge().run(sql, params);
  const res = db().prepare(sql).run(...params);
  return { changes: res.changes, lastInsertRowid: Number(res.lastInsertRowid) };
}

export function tx<T>(fn: () => T): T {
  if (isPostgresEngine()) return pgBridge().transaction(fn);
  const wrapped = db().transaction(fn);
  return wrapped() as T;
}

export function count(sql: string, params: Params = []): number {
  const row = get<{ c: number }>(sql, params);
  const value = row?.c ?? 0;
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** Raw multi-statement execution (migrations, maintenance). */
export function exec(sql: string): void {
  if (isPostgresEngine()) {
    pgBridge().exec(sql);
    return;
  }
  db().exec(sql);
}

/**
 * Test helper: wipe every table between test cases.
 * Works on both engines so the same suite can run against real Postgres.
 */
export function resetDatabaseForTests(): void {
  if (isPostgresEngine()) {
    const tables = all<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
          and table_name not in ('plans','schema_migrations')`
    );
    if (tables.length === 0) return;
    const list = tables.map((t) => `"${t.table_name}"`).join(", ");
    exec(`truncate table ${list} restart identity cascade`);
    return;
  }

  const database = db();
  const tables = all<{ name: string }>(
    "select name from sqlite_master where type='table' and name not in ('plans','schema_migrations')"
  );
  database.pragma("foreign_keys = OFF");
  for (const t of tables) database.prepare(`delete from "${t.name}"`).run();
  database.pragma("foreign_keys = ON");
}
