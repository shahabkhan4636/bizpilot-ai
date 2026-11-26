#!/usr/bin/env node
/**
 * Restore a backup produced by scripts/backup.mjs.
 *
 *   node scripts/restore.mjs backups/bizpilot-2026-08-09_10-00-00.sql.gz --yes
 *   node scripts/restore.mjs <file> --yes --target postgres://…   # explicit target
 *
 * Guardrails, because this command overwrites data:
 *  - refuses without `--yes`;
 *  - refuses to restore over a database that already holds organisations unless
 *    `--force` is passed, so a mistyped command cannot silently merge or clobber;
 *  - verifies the archive gunzips and ends with pg_dump's completion marker
 *    *before* touching the target;
 *  - SQLite: keeps the pre-restore file as `<db>.pre-restore-<timestamp>`.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const has = (name) => args.includes(`--${name}`);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

if (!file) {
  console.error("usage: node scripts/restore.mjs <backup.sql.gz> --yes [--force] [--target <url>]");
  process.exit(2);
}
if (!has("yes")) {
  console.error("✖ refusing to overwrite data without --yes (this is a destructive command).");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`✖ ${file} not found.`);
  process.exit(1);
}

// Keep the bytes: a SQLite backup is a binary database image, and decoding it as
// UTF-8 first would corrupt it ("database disk image is malformed").
const raw = zlib.gunzipSync(fs.readFileSync(file));
const text = raw.toString("utf8");
const isPostgresDump = /PostgreSQL database dump/.test(text);
if (isPostgresDump && !/PostgreSQL database dump complete/.test(text)) {
  console.error("✖ the dump is truncated (no completion marker) — refusing to restore a partial backup.");
  process.exit(1);
}
const databaseUrl = flag("target", process.env.DATABASE_URL ?? "");

function findBinary(names) {
  for (const root of ["/usr/lib/postgresql", "/usr/local/pgsql"]) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      for (const name of names) {
        const candidate = path.join(root, version, "bin", name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const name of names) {
    try {
      const found = execFileSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
      if (found) return found.split("\n").pop();
    } catch {
      /* keep looking */
    }
  }
  return null;
}

if (isPostgresDump) {
  if (!databaseUrl || /^file:/i.test(databaseUrl)) {
    console.error("✖ this is a Postgres dump but no Postgres target was given (--target or DATABASE_URL).");
    process.exit(2);
  }
  const psql = findBinary(["psql"]);
  if (!psql) {
    console.error("✖ psql not found. Install the PostgreSQL client tools.");
    process.exit(1);
  }
  // Two queries, not one: Postgres parses the whole statement, so a conditional
  // `select … from organizations` still fails on a database where the table does
  // not exist yet.
  const hasTable = execFileSync(
    psql,
    [databaseUrl, "-tAc", "select to_regclass('public.organizations') is not null"],
    { encoding: "utf8" }
  ).trim();
  const existing = hasTable === "t"
    ? Number(execFileSync(psql, [databaseUrl, "-tAc", "select count(*) from organizations"], { encoding: "utf8" }).trim())
    : 0;
  if (existing > 0 && !has("force")) {
    console.error(
      `✖ the target already contains ${existing} organisation(s). Restore into an empty database, or pass --force to overwrite.`
    );
    process.exit(1);
  }
  if (has("force")) {
    const owner = databaseUrl.replace(/\?.*$/, "").split("/").pop();
    execFileSync(psql, [databaseUrl, "-v", "ON_ERROR_STOP=1", "-c", `drop schema public cascade; create schema public;`], {
      stdio: "inherit",
    });
    console.log(`  cleared schema public on ${owner}`);
  }
  execFileSync(psql, [databaseUrl, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], {
    input: text,
    stdio: ["pipe", "inherit", "inherit"],
  });
  const tables = execFileSync(
    psql,
    [databaseUrl, "-tAc", "select count(*) from information_schema.tables where table_schema='public'"],
    { encoding: "utf8" }
  ).trim();
  console.log(`✔ restored ${file} → ${databaseUrl.replace(/:\/\/[^@]*@/, "://***@")} (${tables} tables)`);
} else {
  const Database = (await import("better-sqlite3")).default;
  const dest = process.env.BIZPILOT_DB_FILE ?? path.join(process.cwd(), "data", "bizpilot.db");
  if (fs.existsSync(dest)) {
    const backup = `${dest}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(dest, backup);
    console.log(`  kept the current database as ${path.basename(backup)}`);
  }
  fs.writeFileSync(dest, raw);
  const db = new Database(dest, { readonly: true });
  const tables = db.prepare("select count(*) c from sqlite_master where type='table'").get().c;
  db.close();
  console.log(`✔ restored ${file} → ${dest} (${tables} tables)`);
}
