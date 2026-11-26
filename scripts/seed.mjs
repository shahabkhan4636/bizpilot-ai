#!/usr/bin/env node
/**
 * Account bootstrap.
 *
 *   node scripts/seed.mjs                       create/reset the ADMIN_EMAIL account (no fake records)
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
import Database from "better-sqlite3";

const root = process.cwd();
const dbFile = process.env.BIZPILOT_DB_FILE ?? path.join(root, "data", "bizpilot.db");

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const demo = process.argv.includes("--demo");
const email = (arg("--email") ?? process.env.ADMIN_EMAIL ?? "admin@bizpilot.local").toLowerCase();
const password = arg("--password") ?? process.env.SEED_PASSWORD ?? crypto.randomBytes(9).toString("base64url") + "9a";
const fullName = arg("--name") ?? "Workspace Owner";
const adminEmail = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();

if (!fs.existsSync(dbFile)) {
  console.error(`✖ ${dbFile} does not exist. Run: npm run db:migrate`);
  process.exit(1);
}

const db = new Database(dbFile);
db.pragma("foreign_keys = ON");

/** Same format as src/lib/password.ts: scrypt$<salt-hex>$<hash-hex>. */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

const now = new Date().toISOString();
const id = () => crypto.randomUUID();

const existing = db.prepare("select id from profiles where lower(email) = ?").get(email);
if (adminEmail && adminEmail !== email) {
  console.log(`ℹ ADMIN_EMAIL is ${adminEmail}; this account (${email}) will not be a super admin.`);
}
let userId;
if (existing) {
  userId = existing.id;
  db.prepare("update profiles set password_hash = ?, full_name = coalesce(?, full_name), updated_at = ? where id = ?")
    .run(hashPassword(password), fullName, now, userId);
  console.log(`↻ Existing account ${email} — password reset.`);
} else {
  userId = id();
  db.prepare("insert into profiles (id, email, password_hash, full_name, is_super_admin, created_at, updated_at) values (?,?,?,?,?,?,?)")
    .run(userId, email, hashPassword(password), fullName, adminEmail === email ? 1 : 0, now, now);
  console.log(`✔ Created account ${email}.`);
}

let orgId = db.prepare("select organization_id from organization_members where user_id = ?").get(userId)?.organization_id;
if (!orgId) {
  orgId = id();
  const slug = `workspace-${crypto.randomBytes(3).toString("hex")}`;
  db.prepare("insert into organizations (id, name, slug, timezone, currency, created_at, updated_at) values (?,?,?,?,?,?,?)")
    .run(orgId, demo ? "Demo Workspace (sample data)" : `${fullName}'s Workspace`, slug, "Asia/Karachi", "USD", now, now);
  db.prepare("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)")
    .run(id(), orgId, userId, "owner", now);
  db.prepare(`insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at)
              values (?,?,?,?,?,?,?,?)`)
    .run(id(), orgId, "starter", "trialing", "monthly", new Date(Date.now() + 14 * 86400000).toISOString(), now, now);
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
    const exists = db.prepare("select id from leads where organization_id = ? and email = ?").get(orgId, mail);
    if (exists) continue;
    db.prepare(`insert into leads (id, organization_id, name, email, company, source, status, value_cents, assigned_to, created_at, updated_at)
                values (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id(), orgId, name, mail, company, source, status, value, userId, now, now);
  }
  console.log(`✔ Demo leads inserted (only because --demo was passed).`);
}

db.close();
console.log(`\nSign in at /login with:\n  email:    ${email}\n  password: ${password}\n`);
console.log("Change this password in Settings immediately after signing in.");
