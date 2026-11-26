#!/usr/bin/env node
/**
 * Consistent database backup for both engines.
 *
 *   node scripts/backup.mjs                  # → backups/bizpilot-<timestamp>.sql.gz (Postgres)
 *   node scripts/backup.mjs --out dir/       # choose the destination directory
 *   node scripts/backup.mjs --keep 14        # delete backups older than the newest 14
 *
 * Postgres: pg_dump custom-free plain SQL, gzipped, and then *verified* — the
 * dump must end with pg_dump's completion marker and must list the expected
 * tables, otherwise the script exits non-zero instead of leaving a plausible
 * looking file behind. SQLite: `VACUUM INTO` produces a point-in-time copy that
 * is safe while the app is running (WAL included), gzipped the same way.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = Boolean(databaseUrl) && !/^file:/i.test(databaseUrl);
const engine = isPostgres ? "postgres" : "sqlite";
const outDir = path.resolve(flag("out", "backups"));
const keep = Number(flag("keep", "0")) || 0;

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const target = path.join(outDir, `bizpilot-${stamp}.sql.gz`);

function findBinary(names) {
  for (const name of names) {
    try {
      const found = execFileSync("bash", ["-lc", `command -v ${name}`], { encoding: "utf8" }).trim();
      if (found) return found.split("\n").pop();
    } catch {
      /* keep looking */
    }
  }
  // Debian keeps the versioned binaries side by side under /usr/lib/postgresql.
  for (const root of ["/usr/lib/postgresql", "/usr/local/pgsql"]) {
    if (!fs.existsSync(root)) continue;
    for (const version of fs.readdirSync(root)) {
      for (const name of names) {
        const candidate = path.join(root, version, "bin", name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

let plain;
if (isPostgres) {
  const pgDump = findBinary(["pg_dump"]);
  if (!pgDump) {
    console.error("✖ pg_dump not found. Install the PostgreSQL client tools (postgresql-client).");
    process.exit(1);
  }
  plain = execFileSync(pgDump, ["--no-owner", "--no-privileges", databaseUrl], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024 * 512,
  });
  const text = plain.toString("utf8");
  if (!/PostgreSQL database dump complete/.test(text)) {
    console.error("✖ pg_dump output is incomplete — refusing to write a backup that cannot be restored.");
    process.exit(1);
  }
  const tables = (text.match(/^CREATE TABLE /gm) ?? []).length;
  if (tables === 0) {
    console.error("✖ the dump contains no tables — is DATABASE_URL pointing at the right database?");
    process.exit(1);
  }
  console.log(`  pg_dump: ${tables} table(s)`);
} else {
  const Database = (await import("better-sqlite3")).default;
  const source = process.env.BIZPILOT_DB_FILE ?? path.join(process.cwd(), "data", "bizpilot.db");
  if (!fs.existsSync(source)) {
    console.error(`✖ ${source} does not exist — nothing to back up.`);
    process.exit(1);
  }
  const scratch = path.join(outDir, `.snapshot-${stamp}.db`);
  const db = new Database(source, { readonly: true });
  db.exec(`vacuum into '${scratch.replace(/'/g, "''")}'`);
  const tables = db.prepare("select count(*) c from sqlite_master where type='table'").get().c;
  db.close();
  plain = fs.readFileSync(scratch);
  fs.rmSync(scratch);
  console.log(`  sqlite snapshot: ${tables} table(s) from ${source}`);
}

fs.writeFileSync(target, zlib.gzipSync(plain, { level: 9 }));
const size = fs.statSync(target).size;
console.log(`✔ ${engine} backup → ${path.relative(process.cwd(), target)} (${(size / 1024).toFixed(1)} KiB)`);

if (keep > 0) {
  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^bizpilot-.*\.sql\.gz$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) {
    fs.rmSync(path.join(outDir, f));
    console.log(`  pruned ${f}`);
  }
}
