import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { all, get, resetDatabaseForTests, run } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import {
  applyWorkspacePlan,
  getWorkspace,
  listUsers,
  listWorkspaceMembers,
  listWorkspaces,
  suspendWorkspace,
  unsuspendWorkspace,
} from "@/lib/admin/workspaces";
import { isPlatformOwnerWorkspace } from "@/lib/plans";

/**
 * Phase 5 — admin operations on a customer's workspace.
 *
 * Suspension is the sharpest tool on the platform, so the tests are about the boring
 * guarantees: a reason is mandatory, the customer is told, the platform owner's own
 * workspace is refused, and the audit trail says who did it and why.
 */

const ORIGINAL_ENV = { ADMIN_EMAIL: process.env.ADMIN_EMAIL };
const OWNER_EMAIL = "owner@bizpilot.test";

beforeEach(() => {
  resetDatabaseForTests();
  process.env.ADMIN_EMAIL = OWNER_EMAIL;
});

afterEach(() => {
  if (ORIGINAL_ENV.ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = ORIGINAL_ENV.ADMIN_EMAIL;
});

function seedAdmin() {
  const now = nowIso();
  const id = newId();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    id,
    OWNER_EMAIL,
    null,
    "Platform Owner",
    now,
    now,
  ]);
  return { id, email: OWNER_EMAIL };
}

function seedActor(email = "acting-admin@bizpilot.test") {
  const now = nowIso();
  const id = newId();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    id,
    email,
    null,
    "Acting Admin",
    now,
    now,
  ]);
  return { id, email };
}

function seedWorkspace(options: {
  email?: string;
  name?: string;
  planCode?: string;
  leads?: number;
  suspended?: boolean;
} = {}) {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `ws-${newToken(4).toLowerCase()}`;
  const email = options.email ?? `${slug}@example.com`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId,
    email,
    null,
    "Customer Owner",
    now,
    now,
  ]);
  run("insert into organizations (id, name, slug, suspended_at, created_at, updated_at) values (?,?,?,?,?,?)", [
    orgId,
    options.name ?? `Org ${slug}`,
    slug,
    options.suspended ? now : null,
    now,
    now,
  ]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(),
    orgId,
    userId,
    "owner",
    now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, created_at, updated_at) values (?,?,?,?,?,?,?)",
    [newId(), orgId, options.planCode ?? "starter", "active", "monthly", now, now]
  );
  for (let i = 0; i < (options.leads ?? 0); i += 1) {
    run("insert into leads (id, organization_id, name, email, status, created_at, updated_at) values (?,?,?,?,?,?,?)", [
      newId(),
      orgId,
      `Lead ${i}`,
      `lead${i}.${newToken(3)}@example.com`,
      "new",
      now,
      now,
    ]);
  }
  return { userId, orgId, slug, email };
}

describe("listing workspaces", () => {
  it("paginates and never returns more than the page size", () => {
    for (let i = 0; i < 7; i += 1) seedWorkspace({ name: `Customer ${i}` });
    const first = listWorkspaces({ perPage: 5, page: 1 });
    expect(first.rows.length).toBe(5);
    expect(first.total).toBe(7);
    const second = listWorkspaces({ perPage: 5, page: 2 });
    expect(second.rows.length).toBe(2);
  });

  it("searches by name, slug and owner email", () => {
    const target = seedWorkspace({ name: "Glow Salon", email: "glow@salon.example" });
    seedWorkspace({ name: "Other Co" });

    expect(listWorkspaces({ search: "glow" }).rows.map((r) => r.id)).toContain(target.orgId);
    expect(listWorkspaces({ search: "glow@salon" }).rows.map((r) => r.id)).toContain(target.orgId);
    expect(listWorkspaces({ search: target.slug }).rows.map((r) => r.id)).toContain(target.orgId);
    expect(listWorkspaces({ search: "nothing-matches-this" }).rows.length).toBe(0);
  });

  it("filters by plan and by suspension status", () => {
    seedWorkspace({ planCode: "professional", name: "Pro One" });
    const suspended = seedWorkspace({ name: "Suspended Co", suspended: true });

    expect(listWorkspaces({ plan: "professional" }).total).toBe(1);
    expect(listWorkspaces({ status: "suspended" }).rows.map((r) => r.id)).toEqual([suspended.orgId]);
    expect(listWorkspaces({ status: "active" }).total).toBe(1);
  });

  it("counts members and leads for each row", () => {
    const ws = seedWorkspace({ leads: 3 });
    const row = listWorkspaces({ search: ws.slug }).rows[0]!;
    expect(row.members).toBe(1);
    expect(row.leads).toBe(3);
    expect(row.owner_email).toBe(ws.email);
  });

  it("marks the owner's workspace as such, and nothing else", () => {
    // The owner's workspace is recognised by the ADMIN_EMAIL account being its owner,
    // so reuse the seeded profile and rename it rather than duplicating the address.
    const ownerWs = seedWorkspace({ name: "Owner Studio" });
    run("update profiles set email = ? where id = ?", [OWNER_EMAIL, ownerWs.userId]);
    seedWorkspace({ name: "Customer Co" });

    const ownerRow = listWorkspaces({ search: "Owner Studio" }).rows[0]!;
    const customerRow = listWorkspaces({ search: "Customer Co" }).rows[0]!;
    expect(isPlatformOwnerWorkspace(ownerRow.id)).toBe(true);
    expect(isPlatformOwnerWorkspace(customerRow.id)).toBe(false);
  });
});

describe("suspending a workspace", () => {
  it("requires a reason of a useful length", () => {
    const admin = seedAdmin();
    const ws = seedWorkspace();
    const short = suspendWorkspace({ organizationId: ws.orgId, reason: "no", actorId: admin.id });
    expect(short.ok).toBe(false);
    const blank = suspendWorkspace({ organizationId: ws.orgId, reason: "      ", actorId: admin.id });
    expect(blank.ok).toBe(false);
    expect(get<{ suspended_at: string | null }>("select suspended_at from organizations where id = ?", [ws.orgId])?.suspended_at).toBeNull();
  });

  it("stores the reason and the actor, audits both, and notifies the customer", () => {
    const admin = seedAdmin();
    const ws = seedWorkspace();
    const result = suspendWorkspace({ organizationId: ws.orgId, reason: "Payment failed after 3 reminders", actorId: admin.id });
    expect(result.ok).toBe(true);

    const org = get<{ suspended_at: string | null; suspension_reason: string | null; suspended_by: string | null }>(
      "select suspended_at, suspension_reason, suspended_by from organizations where id = ?",
      [ws.orgId]
    );
    expect(org?.suspended_at).toBeTruthy();
    expect(org?.suspension_reason).toBe("Payment failed after 3 reminders");
    expect(org?.suspended_by).toBe(admin.id);

    const auditRow = get<{ action: string; metadata: string }>(
      "select action, metadata from audit_logs where organization_id = ? and action = 'admin.workspace_suspended'",
      [ws.orgId]
    );
    expect(auditRow?.metadata).toContain("Payment failed");

    const notifications = all<{ title: string }>("select title from notifications where organization_id = ?", [ws.orgId]);
    expect(notifications.some((n) => /suspended/i.test(n.title))).toBe(true);

    // The customer is emailed too — queued in the outbox, so a missing provider key
    // means "waiting", not "lost".
    const mail = get<{ to_email: string; status: string; kind: string }>(
      "select to_email, status, kind from email_outbox where organization_id = ? order by created_at desc limit 1",
      [ws.orgId]
    );
    expect(mail).toMatchObject({ to_email: ws.email, kind: "account_email" });
    expect(["queued", "sent"]).toContain(mail!.status);
  });

  it("refuses the platform owner's own workspace", () => {
    // The actor must be a real profile (the FK holds), but not the owner address — that
    // address belongs to the workspace's own owner in this scenario.
    const admin = seedActor();
    const ws = seedWorkspace();
    run("update profiles set email = ? where id = ?", [OWNER_EMAIL, ws.userId]);
    const result = suspendWorkspace({ organizationId: ws.orgId, reason: "testing the guard", actorId: admin.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/platform owner/i);
    expect(get<{ suspended_at: string | null }>("select suspended_at from organizations where id = ?", [ws.orgId])?.suspended_at).toBeNull();
  });

  it("refuses a second suspension and an unknown workspace", () => {
    const admin = seedAdmin();
    const ws = seedWorkspace({ suspended: true });
    expect(suspendWorkspace({ organizationId: ws.orgId, reason: "again and again", actorId: admin.id }).ok).toBe(false);
    expect(suspendWorkspace({ organizationId: newId(), reason: "does not exist", actorId: admin.id }).ok).toBe(false);
  });
});

describe("restoring a workspace", () => {
  it("clears the suspension, keeps the audit trail, and emails the owner", () => {
    const admin = seedAdmin();
    const ws = seedWorkspace();
    suspendWorkspace({ organizationId: ws.orgId, reason: "payment failed", actorId: admin.id });
    const result = unsuspendWorkspace({ organizationId: ws.orgId, reason: "invoice paid — restoring access", actorId: admin.id });
    expect(result.ok).toBe(true);

    const org = get<{ suspended_at: string | null; suspension_reason: string | null }>(
      "select suspended_at, suspension_reason from organizations where id = ?",
      [ws.orgId]
    );
    expect(org?.suspended_at).toBeNull();
    expect(org?.suspension_reason).toBeNull();

    expect(
      all("select id from audit_logs where organization_id = ? and action = 'admin.workspace_unsuspended'", [ws.orgId]).length
    ).toBe(1);
    const subjects = all<{ subject: string }>("select subject from email_outbox where organization_id = ?", [ws.orgId]).map(
      (row) => row.subject
    );
    expect(subjects.some((subject) => /active again/i.test(subject))).toBe(true);
  });

  it("requires a reason and refuses a workspace that is not suspended", () => {
    const admin = seedAdmin();
    const ws = seedWorkspace();
    expect(unsuspendWorkspace({ organizationId: ws.orgId, reason: "          ", actorId: admin.id }).ok).toBe(false);
    const result = unsuspendWorkspace({ organizationId: ws.orgId, reason: "nothing to restore", actorId: admin.id });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not suspended/i);
  });
});

describe("plan assignment", () => {
  it("updates the subscription and records the previous plan", () => {
    const admin = seedAdmin();
    const ws = seedWorkspace({ planCode: "starter" });
    const result = applyWorkspacePlan({ organizationId: ws.orgId, planCode: "professional", actorId: admin.id });
    expect(result.ok).toBe(true);

    const sub = get<{ plan_code: string }>("select plan_code from subscriptions where organization_id = ?", [ws.orgId]);
    expect(sub?.plan_code).toBe("professional");

    const auditRow = get<{ metadata: string }>(
      "select metadata from audit_logs where organization_id = ? and action = 'admin.plan_assigned'",
      [ws.orgId]
    );
    expect(auditRow?.metadata).toContain('"previousPlanCode":"starter"');
  });

  it("creates a subscription when the workspace has none, and rejects an unknown plan", () => {
    const admin = seedAdmin();
    const ws = seedWorkspace();
    run("delete from subscriptions where organization_id = ?", [ws.orgId]);
    expect(applyWorkspacePlan({ organizationId: ws.orgId, planCode: "business", actorId: admin.id }).ok).toBe(true);
    expect(get<{ plan_code: string }>("select plan_code from subscriptions where organization_id = ?", [ws.orgId])?.plan_code).toBe("business");

    const bad = applyWorkspacePlan({ organizationId: ws.orgId, planCode: "not-a-plan", actorId: admin.id });
    expect(bad.ok).toBe(false);
  });
});

describe("detail data", () => {
  it("returns the workspace with its plan limits and usage", () => {
    const ws = seedWorkspace({ planCode: "professional", leads: 2 });
    const detail = getWorkspace(ws.orgId);
    expect(detail?.name).toBeTruthy();
    expect(detail?.plan_code).toBe("professional");
    expect(detail?.leads).toBe(2);
    expect(detail?.leads_limit).toBeGreaterThan(0);
    expect(detail?.owner_email).toBe(ws.email);
    expect(getWorkspace(newId())).toBeUndefined();
  });

  it("lists members with their role and last sign-in", () => {
    const ws = seedWorkspace();
    const now = nowIso();
    run("insert into sessions (id, user_id, expires_at, created_at) values (?,?,?,?)", [
      newToken(24),
      ws.userId,
      new Date(Date.now() + 86_400_000).toISOString(),
      now,
    ]);
    const members = listWorkspaceMembers(ws.orgId);
    expect(members.length).toBe(1);
    expect(members[0]).toMatchObject({ email: ws.email, role: "owner" });
    expect(members[0]?.last_session_at).toBe(now);
  });

  it("lists users across workspaces with verification state", () => {
    const ws = seedWorkspace({ email: "person@example.com" });
    const { rows, total } = listUsers({ search: "person@" });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ email: "person@example.com", workspaces: 1, role: "owner" });
    expect(rows[0]?.email_verified_at).toBeNull();

    run("update profiles set email_verified_at = ? where id = ?", [nowIso(), ws.userId]);
    expect(listUsers({ search: "person@" }).rows[0]?.email_verified_at).toBeTruthy();
  });
});
