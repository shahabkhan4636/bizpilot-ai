import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

/**
 * Row Level Security — verified against a real PostgreSQL engine (PGlite = Postgres
 * compiled to WASM), not against mocks.
 *
 * What this proves:
 *   1. sql/schema.postgres.sql applies cleanly on PostgreSQL.
 *   2. RLS is enabled on every tenant table.
 *   3. A signed-in user can only read rows belonging to their own organisation.
 *   4. A cross-tenant INSERT is rejected by the policy WITH CHECK clause.
 *   5. A super admin (is_super_admin = true) can read across tenants.
 *
 * The app's runtime adapter for Postgres is a separate, unfinished piece of work —
 * this suite answers the question "are the policies themselves correct?".
 */

const root = process.cwd();
const shim = fs.readFileSync(path.join(root, "sql/local-postgres-shim.sql"), "utf8");
// PGlite does not bundle the pgcrypto contrib extension; PostgreSQL 13+ provides
// gen_random_uuid() in core, so the extension line is dropped for this engine only.
const schema = fs
  .readFileSync(path.join(root, "sql/schema.postgres.sql"), "utf8")
  .replace(/create extension if not exists "pgcrypto";/i, "");
const seed = fs.readFileSync(path.join(root, "sql/seed_plans.postgres.sql"), "utf8");

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-cccc-cccc-cccccccccccc";

let db: PGlite;

async function asUser(userId: string | null, fn: () => Promise<void>) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId ?? ""]);
  await db.exec("set role app_user");
  try {
    await fn();
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(shim);
  await db.exec(schema);
  await db.exec(seed);

  // A non-owner role: table owners bypass RLS, so the policies can only be
  // exercised from a role that does not own the tables.
  await db.exec(`
    drop role if exists app_user;
    create role app_user nologin;
    grant usage on schema public, auth to app_user;
    grant select, insert, update, delete on all tables in schema public to app_user;
    grant execute on all functions in schema public to app_user;
    grant execute on all functions in schema auth to app_user;
  `);

  // Seed as the superuser (bypasses RLS).
  await db.exec(`
    insert into auth.users (id, email) values
      ('${USER_A}', 'owner-a@example.com'),
      ('${USER_B}', 'owner-b@example.com'),
      ('${ADMIN}',  'admin@example.com');

    insert into profiles (id, email, full_name, is_super_admin) values
      ('${USER_A}', 'owner-a@example.com', 'Owner A', false),
      ('${USER_B}', 'owner-b@example.com', 'Owner B', false),
      ('${ADMIN}',  'admin@example.com',   'Platform Admin', true);

    insert into organizations (id, name, slug) values
      ('${ORG_A}', 'Alpha Workspace', 'alpha'),
      ('${ORG_B}', 'Beta Workspace',  'beta');

    insert into organization_members (organization_id, user_id, role) values
      ('${ORG_A}', '${USER_A}', 'owner'),
      ('${ORG_B}', '${USER_B}', 'owner');

    insert into subscriptions (organization_id, plan_code, status) values
      ('${ORG_A}', 'starter', 'active'),
      ('${ORG_B}', 'starter', 'active');

    insert into leads (organization_id, name, email, source, status, value_cents) values
      ('${ORG_A}', 'Alpha Lead', 'alpha@x.com', 'manual', 'new', 100000),
      ('${ORG_B}', 'Beta Lead',  'beta@x.com',  'manual', 'new', 200000);
  `);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("Postgres schema", () => {
  it("applies on a real PostgreSQL engine", async () => {
    const tables = await db.query<{ count: number }>(
      "select count(*)::int as count from information_schema.tables where table_schema = 'public'"
    );
    expect(tables.rows[0]!.count).toBeGreaterThanOrEqual(20);
  });

  it("enables RLS on every tenant table", async () => {
    const rows = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r'`
    );
    const tenantTables = ["leads", "customers", "proposals", "documents", "automations", "audit_logs", "usage_records"];
    for (const table of tenantTables) {
      const row = rows.rows.find((r) => r.relname === table);
      expect(row, `${table} should exist`).toBeTruthy();
      expect(row!.relrowsecurity, `${table} should have RLS enabled`).toBe(true);
    }
  });

  it("seeds the four commercial plans", async () => {
    const plans = await db.query<{ code: string; price_monthly_cents: number }>(
      "select code, price_monthly_cents from plans order by sort_order"
    );
    expect(plans.rows.map((p) => p.code)).toEqual(["starter", "professional", "business", "agency"]);
    expect(plans.rows[0]!.price_monthly_cents).toBe(2900);
  });
});

describe("row level security", () => {
  it("shows user A only their own workspace leads", async () => {
    await asUser(USER_A, async () => {
      const result = await db.query<{ name: string; organization_id: string }>("select name, organization_id from leads");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.name).toBe("Alpha Lead");
      expect(result.rows[0]!.organization_id).toBe(ORG_A);
    });
  });

  it("shows user B only their own workspace leads", async () => {
    await asUser(USER_B, async () => {
      const result = await db.query<{ name: string }>("select name from leads");
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.name).toBe("Beta Lead");
    });
  });

  it("hides the other tenant's organisation row", async () => {
    await asUser(USER_A, async () => {
      const orgs = await db.query<{ slug: string }>("select slug from organizations order by slug");
      expect(orgs.rows.map((o) => o.slug)).toEqual(["alpha"]);
    });
  });

  it("blocks a cross-tenant SELECT even when the id is known", async () => {
    await asUser(USER_A, async () => {
      const result = await db.query("select id from leads where organization_id = $1", [ORG_B]);
      expect(result.rows).toHaveLength(0);
    });
  });

  it("rejects an INSERT into another tenant", async () => {
    await asUser(USER_A, async () => {
      await expect(
        db.query(
          "insert into leads (organization_id, name, source, status, value_cents) values ($1, 'Injected', 'manual', 'new', 0)",
          [ORG_B]
        )
      ).rejects.toThrow();
    });
  });

  it("allows an INSERT into the caller's own tenant", async () => {
    await asUser(USER_A, async () => {
      await db.query(
        "insert into leads (organization_id, name, email, source, status, value_cents) values ($1, 'Mine', 'mine@x.com', 'manual', 'new', 5000)",
        [ORG_A]
      );
      const mine = await db.query<{ name: string }>("select name from leads where name = 'Mine'");
      expect(mine.rows).toHaveLength(1);
    });
  });

  it("lets a super admin read across tenants", async () => {
    await asUser(ADMIN, async () => {
      const result = await db.query<{ count: number }>("select count(*)::int as count from leads");
      expect(result.rows[0]!.count).toBeGreaterThanOrEqual(2);
    });
  });

  it("keeps plans readable to everyone but writable only by a super admin", async () => {
    await asUser(USER_A, async () => {
      const plans = await db.query("select code from plans");
      expect(plans.rows.length).toBe(4);
      await expect(db.query("update plans set price_monthly_cents = 1 where code = 'starter'")).resolves.toBeTruthy();
      // The update affects 0 rows because no policy allows it, so re-check the value as the owner.
    });
    const after = await db.query<{ price_monthly_cents: number }>(
      "select price_monthly_cents from plans where code = 'starter'"
    );
    expect(after.rows[0]!.price_monthly_cents).toBe(2900);
  });

  it("prevents user A from reading user B's profile row", async () => {
    await asUser(USER_A, async () => {
      const profiles = await db.query<{ email: string }>("select email from profiles");
      expect(profiles.rows.map((p) => p.email)).toEqual(["owner-a@example.com"]);
    });
  });
});
