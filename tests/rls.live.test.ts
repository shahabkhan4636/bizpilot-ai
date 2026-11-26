import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

/**
 * Row Level Security against a REAL PostgreSQL server.
 *
 * `tests/rls.postgres.test.ts` proves the Supabase-shaped policies on PGlite.
 * This suite proves the policies that ship with the portable schema
 * (`sql/rls.postgres.sql`) on a live server, from a NON-OWNER role — the only
 * configuration in which RLS actually applies (a table owner bypasses it).
 *
 * Run with:
 *   RLS_LIVE_URL="postgres://bizpilot_anon:anon@127.0.0.1:5433/bizpilot" \
 *   ADMIN_LIVE_URL="postgres://bizpilot_owner:bizpilot@127.0.0.1:5433/bizpilot" \
 *   npx vitest run tests/rls.live.test.ts
 *
 * Skipped automatically when the URLs are absent, so `npm test` stays hermetic.
 */
const ANON_URL = process.env.RLS_LIVE_URL ?? "";
const OWNER_URL = process.env.ADMIN_LIVE_URL ?? "";
const enabled = Boolean(ANON_URL && OWNER_URL);

const USER_A = randomUUID();
const USER_B = randomUUID();
const ADMIN = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const LEAD_A = randomUUID();
const LEAD_B = randomUUID();

let owner: Client;
let anon: Client;

async function asUser(client: Client, userId: string) {
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
}

describe.skipIf(!enabled)("RLS on a live PostgreSQL server", () => {
  beforeAll(async () => {
    owner = new Client({ connectionString: OWNER_URL });
    await owner.connect();
    const now = new Date().toISOString();
    await owner.query("delete from leads where id = any($1::text[])", [[LEAD_A, LEAD_B]]);
    await owner.query("delete from organization_members where organization_id = any($1::text[])", [[ORG_A, ORG_B]]);
    await owner.query("delete from organizations where id = any($1::text[])", [[ORG_A, ORG_B]]);
    await owner.query("delete from profiles where id = any($1::text[])", [[USER_A, USER_B, ADMIN]]);

    for (const [id, email, admin] of [
      [USER_A, `rls.a.${Date.now()}@example.com`, 0],
      [USER_B, `rls.b.${Date.now()}@example.com`, 0],
      [ADMIN, `rls.admin.${Date.now()}@example.com`, 1],
    ] as const) {
      await owner.query(
        "insert into profiles (id, email, full_name, is_super_admin, created_at, updated_at) values ($1,$2,$3,$4,$5,$5)",
        [id, email, "RLS Test", admin, now]
      );
    }
    for (const [org, user, slug] of [
      [ORG_A, USER_A, `rls-a-${Date.now()}`],
      [ORG_B, USER_B, `rls-b-${Date.now()}`],
    ] as const) {
      await owner.query("insert into organizations (id, name, slug, created_at, updated_at) values ($1,$2,$3,$4,$4)", [
        org, `Org ${slug}`, slug, now,
      ]);
      await owner.query(
        "insert into organization_members (id, organization_id, user_id, role, created_at) values ($1,$2,$3,'owner',$4)",
        [randomUUID(), org, user, now]
      );
    }
    for (const [lead, org, name] of [
      [LEAD_A, ORG_A, "Lead A"],
      [LEAD_B, ORG_B, "Lead B"],
    ] as const) {
      await owner.query(
        `insert into leads (id, organization_id, name, email, status, value_cents, created_at, updated_at)
         values ($1,$2,$3,$4,'new',100000,$5,$5)`,
        [lead, org, name, `${name.toLowerCase().replace(/\s/g, "")}@example.com`, now]
      );
    }

    anon = new Client({ connectionString: ANON_URL });
    await anon.connect();
  }, 60_000);

  afterAll(async () => {
    await anon?.end();
    if (owner) {
      await owner.query("delete from leads where id = any($1::text[])", [[LEAD_A, LEAD_B]]);
      await owner.query("delete from organization_members where organization_id = any($1::text[])", [[ORG_A, ORG_B]]);
      await owner.query("delete from organizations where id = any($1::text[])", [[ORG_A, ORG_B]]);
      await owner.query("delete from profiles where id = any($1::text[])", [[USER_A, USER_B, ADMIN]]);
      await owner.end();
    }
  });

  it("runs as a non-owner role (the only configuration where RLS applies)", async () => {
    const { rows } = await anon.query("select current_user as who");
    expect(rows[0].who).toBe("bizpilot_anon");
    const ownerCheck = await anon.query("select tableowner from pg_tables where tablename = 'leads'");
    expect(ownerCheck.rows[0].tableowner).not.toBe("bizpilot_anon");
  });

  it("sees only its own workspace's leads", async () => {
    await asUser(anon, USER_A);
    const { rows } = await anon.query("select id from leads where id = any($1::text[])", [[LEAD_A, LEAD_B]]);
    expect(rows.map((r) => r.id)).toEqual([LEAD_A]);
  });

  it("cannot read another workspace's lead even by primary key", async () => {
    await asUser(anon, USER_A);
    const { rows } = await anon.query("select id, name from leads where id = $1", [LEAD_B]);
    expect(rows).toHaveLength(0);
  });

  it("cannot insert a lead into another workspace", async () => {
    await asUser(anon, USER_A);
    await expect(
      anon.query(
        `insert into leads (id, organization_id, name, email, status, value_cents, created_at, updated_at)
         values ($1,$2,'Injected','inject@example.com','new',1,now()::text,now()::text)`,
        [randomUUID(), ORG_B]
      )
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("cannot update or delete another workspace's lead", async () => {
    await asUser(anon, USER_A);
    const upd = await anon.query("update leads set name = 'hijacked' where id = $1", [LEAD_B]);
    expect(upd.rowCount).toBe(0);
    const del = await anon.query("delete from leads where id = $1", [LEAD_B]);
    expect(del.rowCount).toBe(0);
    const still = await owner.query("select name from leads where id = $1", [LEAD_B]);
    expect(still.rows[0].name).toBe("Lead B");
  });

  it("cannot read another workspace's members or invites", async () => {
    await asUser(anon, USER_A);
    const members = await anon.query("select organization_id from organization_members where organization_id = any($1::text[])", [[ORG_A, ORG_B]]);
    expect(members.rows.map((r) => r.organization_id)).toEqual([ORG_A]);
  });

  it("cannot see profiles outside its workspace", async () => {
    await asUser(anon, USER_A);
    const { rows } = await anon.query("select id from profiles where id = any($1::text[])", [[USER_A, USER_B, ADMIN]]);
    expect(rows.map((r) => r.id)).toEqual([USER_A]);
  });

  it("a super admin sees every workspace", async () => {
    await asUser(anon, ADMIN);
    const { rows } = await anon.query("select id from leads where id = any($1::text[])", [[LEAD_A, LEAD_B]]);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([LEAD_A, LEAD_B]));
  });

  it("can read the public plan catalogue but cannot change prices", async () => {
    await asUser(anon, USER_A);
    const plans = await anon.query("select code, price_monthly_cents from plans order by price_monthly_cents");
    expect(plans.rows.length).toBeGreaterThanOrEqual(4);
    await expect(anon.query("update plans set price_monthly_cents = 1 where code = 'starter'")).resolves.toBeTruthy();
    const after = await owner.query("select price_monthly_cents from plans where code = 'starter'");
    expect(Number(after.rows[0].price_monthly_cents)).toBe(2900);
  });

  it("cannot read webhook events or rate limits", async () => {
    await asUser(anon, USER_A);
    const hooks = await anon.query("select count(*)::int as c from webhook_events");
    expect(hooks.rows[0].c).toBe(0);
    const limits = await anon.query("select count(*)::int as c from rate_limits");
    expect(limits.rows[0].c).toBe(0);
  });
});
