#!/usr/bin/env node
/**
 * Versioned migration runner. Works on both engines.
 *
 *   node scripts/db-migrate.mjs               apply every pending migration
 *   node scripts/db-migrate.mjs --status      show applied / pending
 *   node scripts/db-migrate.mjs --down 1      roll back the last N migrations
 *   node scripts/db-migrate.mjs --to 001      migrate up to (and including) 001
 *
 *   Postgres: uses DATABASE_URL.
 *   SQLite:   uses BIZPILOT_DB_FILE (default data/bizpilot.db).
 *
 * Every migration runs inside a transaction together with its bookkeeping row, so
 * a failure leaves the database exactly as it was. Names and checksums are stored
 * in `schema_migrations`; editing an already-applied file is reported as drift
 * instead of being silently ignored.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const dir = path.join(process.cwd(), "sql", "migrations");
const url = process.env.DATABASE_URL;
const usePostgres = Boolean(url) || process.env.BIZPILOT_ENGINE === "postgres";

if (!fs.existsSync(dir)) {
  console.error("✖ sql/migrations does not exist");
  process.exit(1);
}

const engine = process.env.DATABASE_URL ? "postgres" : process.env.BIZPILOT_ENGINE === "postgres" ? "postgres" : "sqlite";

/**
 * A migration may ship a portable file (`.up.sql`) or engine-specific files
 * (`.up.postgres.sql` / `.up.sqlite.sql`) when the DDL genuinely differs — e.g.
 * SQLite cannot alter a CHECK constraint and needs a table rebuild, whereas
 * Postgres drops and re-adds the constraint in place. The engine-specific file
 * wins when present; otherwise the portable one is used.
 */
function pick(file) {
  const base = file.replace(/\.up\.sql$/, "");
  const engineFile = path.join(dir, `${base}.up.${engine}.sql`);
  if (fs.existsSync(engineFile)) return { path: engineFile, label: `${base}.up.${engine}.sql` };
  const portable = path.join(dir, `${base}.up.sql`);
  if (fs.existsSync(portable)) return { path: portable, label: `${base}.up.sql` };
  return null;
}

const allFiles = fs.readdirSync(dir);
const upNames = [...new Set(
  allFiles
    .filter((f) => /\.up\.(sql|postgres\.sql|sqlite\.sql)$/.test(f))
    .map((f) => f.replace(/\.up\.(postgres|sqlite)?\.?sql$/, ""))
)].sort();

const migrations = upNames.map((base) => {
  const chosen = pick(`${base}.up.sql`);
  if (!chosen) throw new Error(`no .up file for ${base}`);
  const sql = fs.readFileSync(chosen.path, "utf8");
  const downPath = [
    path.join(dir, `${base}.down.${engine}.sql`),
    path.join(dir, `${base}.down.sql`),
  ].find((p) => fs.existsSync(p));
  return {
    id: base.split("_")[0],
    name: base,
    file: chosen.label,
    sql,
    checksum: crypto.createHash("sha256").update(sql).digest("hex").slice(0, 16),
    down: downPath ? fs.readFileSync(downPath, "utf8") : null,
  };
});

const BOOKKEEPING = `create table if not exists schema_migrations (
  id text primary key,
  name text not null,
  checksum text not null,
  applied_at text not null
)`;

let driver;
if (usePostgres) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  // Postgres uses $1..$n; the runner writes ? so both engines can share code.
  const pos = (sql) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  driver = {
    engine: "postgres",
    label: url.replace(/\/\/[^@]*@/, "//***@"),
    query: (sql, params = []) => client.query(pos(sql), params),
    exec: async (sql) => {
      await client.query(sql);
    },
    transaction: async (fn) => {
      await client.query("begin");
      try {
        await fn();
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    },
    close: () => client.end(),
  };
} else {
  const { default: Database } = await import("better-sqlite3");
  const file = process.env.BIZPILOT_DB_FILE ?? path.join(process.cwd(), "data", "bizpilot.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  driver = {
    engine: "sqlite",
    label: file,
    query: async (sql, params = []) => {
      const stmt = sqlite.prepare(sql);
      // better-sqlite3 distinguishes readers from writers; DDL/DML must use run().
      return { rows: stmt.reader ? stmt.all(...params) : (stmt.run(...params), []) };
    },
    exec: async (sql) => {
      sqlite.exec(sql);
    },
    transaction: async (fn) => {
      sqlite.exec("begin");
      try {
        await fn();
        sqlite.exec("commit");
      } catch (e) {
        sqlite.exec("rollback");
        throw e;
      }
    },
    close: async () => sqlite.close(),
  };
}

console.log(`→ engine=${driver.engine} target=${driver.label}`);
await driver.exec(BOOKKEEPING);

const applied = (await driver.query("select id, name, checksum, applied_at from schema_migrations order by id")).rows;
const byId = new Map(applied.map((r) => [r.id, r]));

// drift detection
// `snapshot` is the sentinel written when a database was created from the
// consolidated snapshot (the app's boot path). There is no per-file checksum to
// compare against in that case, so it is recorded as "unknown" rather than
// reported as an edit to history.
const BASELINE_CHECKSUM = "snapshot";
for (const m of migrations) {
  const row = byId.get(m.id);
  if (row && row.checksum === BASELINE_CHECKSUM) continue;
  if (row && row.checksum !== m.checksum) {
    console.error(
      `✖ ${m.name} changed after it was applied (checksum ${row.checksum} → ${m.checksum}).\n` +
        "  Add a new migration instead of editing history; existing databases will not re-run it."
    );
    process.exit(1);
  }
}

/**
 * The plan catalogue is data, not schema, but it is required: `subscriptions.plan_code`
 * references `plans(code)`, so a freshly migrated database with an empty catalogue
 * fails the first signup with a foreign-key error. The statements are upserts, so
 * running this on every migrate is safe and lets pricing change without code edits.
 */
async function seedPlans() {
  const file = path.join(process.cwd(), "sql", "seed_plans.sql");
  if (!fs.existsSync(file)) return;
  try {
    await driver.exec(fs.readFileSync(file, "utf8"));
    const count = (await driver.query("select count(*) as c from plans")).rows[0].c;
    console.log(`✔ plan catalogue in place (${Number(count)} plans)`);
  } catch (error) {
    console.error(`✖ could not apply the plan catalogue: ${error.message}`);
    await driver.close();
    process.exit(1);
  }
}

const status = args.includes("--status");
const baseline = args.includes("--baseline");
const downIndex = args.indexOf("--down");
const toIndex = args.indexOf("--to");

if (baseline) {
  // A database created from the consolidated snapshot already contains every
  // migration's DDL. Recording them as applied (without running them) is what
  // stops the runner from trying to add columns that already exist.
  let recorded = 0;
  for (const m of migrations) {
    if (byId.has(m.id)) continue;
    await driver.query(
      "insert into schema_migrations (id, name, checksum, applied_at) values (?,?,?,?)",
      [m.id, m.name, m.checksum, new Date().toISOString()]
    );
    recorded += 1;
  }
  console.log(`✔ baseline: ${recorded} migration(s) recorded as applied`);
  await driver.close();
  process.exit(0);
}

if (status) {
  console.log("\n id   state    checksum          name");
  for (const m of migrations) {
    const row = byId.get(m.id);
    console.log(` ${m.id}  ${row ? "applied" : "pending"}  ${m.checksum}  ${m.name}`);
  }
  console.log(`\n${applied.length} applied · ${migrations.length - applied.length} pending\n`);
  await driver.close();
  process.exit(0);
}

if (downIndex >= 0) {
  const count = Number(args[downIndex + 1] ?? 1);
  const targets = applied.slice(-count).reverse();
  if (targets.length === 0) {
    console.log("Nothing to roll back.");
    await driver.close();
    process.exit(0);
  }
  for (const row of targets) {
    const m = migrations.find((x) => x.id === row.id);
    if (!m?.down) {
      console.error(`✖ ${row.name} has no .down.sql`);
      await driver.close();
      process.exit(1);
    }
    console.log(`← rolling back ${m.name}`);
    try {
      await driver.transaction(async () => {
        await driver.exec(m.down);
        await driver.query("delete from schema_migrations where id = ?", [m.id]);
      });
    } catch (error) {
      console.error(`✖ rollback of ${m.name} failed: ${error.message}`);
      await driver.close();
      process.exit(1);
    }
  }
  console.log(`✔ rolled back ${targets.length} migration(s)`);
  await driver.close();
  process.exit(0);
}

const limit = toIndex >= 0 ? String(args[toIndex + 1] ?? "") : null;
const pending = migrations.filter((m) => !byId.has(m.id) && (!limit || m.id <= limit));

if (pending.length === 0) {
  console.log(`✔ up to date (${applied.length} migration(s) applied)`);
  await seedPlans();
  await driver.close();
  process.exit(0);
}

for (const m of pending) {
  process.stdout.write(`→ applying ${m.name} (${m.file}) … `);
  try {
    await driver.transaction(async () => {
      await driver.exec(m.sql);
      await driver.query(
        "insert into schema_migrations (id, name, checksum, applied_at) values (?,?,?,?)",
        [m.id, m.name, m.checksum, new Date().toISOString()]
      );
    });
    console.log("ok");
  } catch (error) {
    console.log("FAILED");
    console.error(`✖ ${m.name}: ${error.message}`);
    await driver.close();
    process.exit(1);
  }
}

const finalCount = (await driver.query("select count(*) as c from schema_migrations")).rows[0].c;
console.log(`✔ ${pending.length} migration(s) applied · ${Number(finalCount)} total`);
await seedPlans();
await driver.close();
