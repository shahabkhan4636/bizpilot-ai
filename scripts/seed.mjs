#!/usr/bin/env node
/**
 * Account bootstrap.
 *
 *   node scripts/seed.mjs                       create/reset the ADMIN_EMAIL account (no fake records)
 *   node scripts/seed.mjs --demo --postgres     same, against DATABASE_URL
 *   node scripts/seed.mjs --demo                additionally create a DEMO workspace with sample leads
 *   node scripts/seed.mjs --email a@b.com --password 'Secret12345' --name 'Ayesha'
 *
 * The default path creates exactly one real account so there is something to log
 * in with. It does NOT populate a dashboard with invented customers: any sample
 * data requires the explicit --demo flag and is labelled as demo in the org name.
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const root = process.cwd();
const dbFile = process.env.BIZPILOT_DB_FILE ?? path.join(root, "data", "bizpilot.db");
const usePostgres = process.argv.includes("--postgres") || Boolean(process.env.DATABASE_URL);

/* ------------------------------------------------------------------ */
/* One tiny adapter so the same seeding logic drives SQLite or Postgres */
/* ------------------------------------------------------------------ */
let q;
if (usePostgres) {
  if (!process.env.DATABASE_URL) {
    console.error("✖ DATABASE_URL is not set, cannot seed Postgres.");
    process.exit(1);
  }
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // Postgres uses $1..$n; this script writes ?. Never inside quoted literals: the
  // statements here contain none.
  const pos = (sql) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  q = {
    get: async (sql, params = []) => (await client.query(pos(sql), params)).rows[0],
    all: async (sql, params = []) => (await client.query(pos(sql), params)).rows,
    run: async (sql, params = []) => client.query(pos(sql), params),
    close: async () => client.end(),
    engine: "postgres",
  };
} else {
  const { default: Database } = await import("better-sqlite3");
  if (!fs.existsSync(dbFile)) {
    console.error(`✖ ${dbFile} does not exist. Run: npm run db:migrate`);
    process.exit(1);
  }
  const sqlite = new Database(dbFile);
  sqlite.pragma("foreign_keys = ON");
  q = {
    get: async (sql, params = []) => sqlite.prepare(sql).get(...params),
    all: async (sql, params = []) => sqlite.prepare(sql).all(...params),
    run: async (sql, params = []) => sqlite.prepare(sql).run(...params),
    close: async () => sqlite.close(),
    engine: "sqlite",
  };
}

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const demo = process.argv.includes("--demo");
const email = (arg("--email") ?? process.env.ADMIN_EMAIL ?? "admin@bizpilot.local").toLowerCase();
const password = arg("--password") ?? process.env.SEED_PASSWORD ?? crypto.randomBytes(9).toString("base64url") + "9a";
const fullName = arg("--name") ?? "Workspace Owner";
const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();

/** Same format as src/lib/password.ts: scrypt$<salt-hex>$<hash-hex>. */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

const now = new Date().toISOString();
const id = () => crypto.randomUUID();

const existing = await q.get("select id from profiles where lower(email) = ?", [email]);
if (adminEmail && adminEmail !== email) {
  console.log(`ℹ ADMIN_EMAIL is ${adminEmail}; this account (${email}) will not be a super admin.`);
}
let userId;
if (existing) {
  userId = existing.id;
  await q.run("update profiles set password_hash = ?, full_name = coalesce(?, full_name), updated_at = ? where id = ?",
    [hashPassword(password), fullName, now, userId]);
  console.log(`↻ Existing account ${email} — password reset.`);
} else {
  userId = id();
  await q.run("insert into profiles (id, email, password_hash, full_name, is_super_admin, created_at, updated_at) values (?,?,?,?,?,?,?)",
    [userId, email, hashPassword(password), fullName, adminEmail === email ? 1 : 0, now, now]);
  console.log(`✔ Created account ${email}.`);
}

let orgId = (await q.get("select organization_id from organization_members where user_id = ?", [userId]))?.organization_id;
if (!orgId) {
  orgId = id();
  const slug = `workspace-${crypto.randomBytes(3).toString("hex")}`;
  await q.run("insert into organizations (id, name, slug, timezone, currency, created_at, updated_at) values (?,?,?,?,?,?,?)",
    [orgId, demo ? "Demo Workspace (sample data)" : `${fullName}'s Workspace`, slug, "Asia/Karachi", "USD", now, now]);
  await q.run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)",
    [id(), orgId, userId, "owner", now]);
  await q.run(`insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at)
              values (?,?,?,?,?,?,?,?)`,
    [id(), orgId, "starter", "trialing", "monthly", new Date(Date.now() + 14 * 86400000).toISOString(), now, now]);
  console.log(`✔ Created workspace + Starter trial.`);
} else {
  console.log(`↻ Account already belongs to workspace ${orgId}.`);
}

if (demo) {
  const leads = [
    ["Sara Ahmed", "sara@vertexinteriors.example", "Vertex Interiors", "referral", "qualified", 250000],
    ["Bilal Khan", "bilal@northwind.example", "Northwind Studio", "website", "new", 120000],
    ["Hina Raza", "hina@lumenclinic.example", "Lumen Clinic", "public_form", "proposal_sent", 480000],
  ];
  for (const [name, mail, company, source, status, value] of leads) {
    const exists = await q.get("select id from leads where organization_id = ? and email = ?", [orgId, mail]);
    if (exists) continue;
    await q.run(`insert into leads (id, organization_id, name, email, company, source, status, value_cents, assigned_to, created_at, updated_at)
                values (?,?,?,?,?,?,?,?,?,?,?)`,
      [id(), orgId, name, mail, company, source, status, value, userId, now, now]);
  }
  console.log(`✔ Demo leads inserted (only because --demo was passed).`);
}

await q.close();
console.log(`\nSign in at /login with:\n  email:    ${email}\n  password: ${password}\n`);
console.log("Change this password in Settings immediately after signing in.");
