import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Data layer
 * ----------
 * Runtime engine for development & demo: SQLite (better-sqlite3).
 * Production engine: Supabase Postgres — schema + RLS policies live in
 * `sql/schema.postgres.sql`. The Postgres adapter is intentionally NOT wired
 * until Supabase credentials are supplied, so nothing here can silently
 * pretend Postgres is in use. See README → "Switching to Supabase".
 */

export type Row = Record<string, unknown>;
export type Params = unknown[];

const DB_DIR = path.join(process.cwd(), "data");
const DB_FILE = process.env.BIZPILOT_DB_FILE ?? path.join(DB_DIR, "bizpilot.db");

type GlobalCache = { __bizpilotDb?: Database.Database };
const g = globalThis as unknown as GlobalCache;

function readSql(file: string): string {
  const p = path.join(process.cwd(), "sql", file);
  return fs.readFileSync(p, "utf8");
}

function initialise(): Database.Database {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  const database = new Database(DB_FILE);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  const hasPlans = database
    .prepare("select name from sqlite_master where type='table' and name='plans'")
    .get() as { name?: string } | undefined;

  if (!hasPlans) {
    database.exec(readSql("schema.sqlite.sql"));
  }
  // Idempotent plan seed (upsert) so pricing can change without code edits.
  database.exec(readSql("seed_plans.sql"));
  return database;
}

export function db(): Database.Database {
  if (!g.__bizpilotDb) g.__bizpilotDb = initialise();
  return g.__bizpilotDb;
}

/* ------------------------------------------------------------------ */
/* Query helpers                                                       */
/* ------------------------------------------------------------------ */

export function all<T = Row>(sql: string, params: Params = []): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, params: Params = []): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, params: Params = []): Database.RunResult {
  return db().prepare(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  const database = db();
  const wrapped = database.transaction(fn);
  return wrapped() as T;
}

export function count(sql: string, params: Params = []): number {
  const row = get<{ c: number }>(sql, params);
  return row?.c ?? 0;
}

/** Test helper: wipe every table between test cases. */
export function resetDatabaseForTests(): void {
  const database = db();
  const tables = all<{ name: string }>(
    "select name from sqlite_master where type='table' and name not in ('plans')"
  );
  database.pragma("foreign_keys = OFF");
  for (const t of tables) database.prepare(`delete from ${t.name}`).run();
  database.pragma("foreign_keys = ON");
}
