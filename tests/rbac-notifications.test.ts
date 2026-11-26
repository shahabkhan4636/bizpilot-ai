import { describe, it, expect, beforeEach } from "vitest";
import { run, get, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { hashPassword } from "@/lib/password";
import {
  can, permissionsFor, isReadOnly, canManageWorkspace, canEditOwnedRecord,
  PERMISSIONS, ROLES, type Role,
} from "@/lib/permissions";
import { notify, listNotifications, unreadCount, markRead, markAllRead } from "@/lib/notifications";

async function seedOrg(planCode = "business") {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `rbac-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${slug}@example.com`, await hashPassword("CorrectHorse42"), "RBAC User", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, `Org ${slug}`, slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, "owner", now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, planCode, "active", "monthly", addDays(14).toISOString(), now, now]
  );
  return { userId, orgId };
}

function addMember(orgId: string, role: string) {
  const now = nowIso();
  const userId = newId();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${role}-${newToken(4)}@example.com`, null, `${role} user`, now, now,
  ]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, role, now,
  ]);
  return userId;
}

describe("permission matrix", () => {
  it("grants an owner every permission", () => {
    for (const permission of PERMISSIONS) expect(can("owner", permission)).toBe(true);
  });

  it("only the owner may delete the workspace", () => {
    expect(can("owner", "workspace:delete")).toBe(true);
    for (const role of ["admin", "manager", "member", "viewer"] as Role[]) {
      expect(can(role, "workspace:delete")).toBe(false);
    }
  });

  it("viewers can read but never write", () => {
    const writes = PERMISSIONS.filter((p) => /:(write|delete|upload|manage|act|generate)$/.test(p));
    for (const permission of writes) {
      expect(can("viewer", permission), `viewer must not ${permission}`).toBe(false);
    }
    expect(can("viewer", "lead:read")).toBe(true);
    expect(can("viewer", "analytics:read")).toBe(true);
    expect(isReadOnly("viewer")).toBe(true);
  });

  it("a sales rep can work leads and proposals but cannot administer", () => {
    expect(can("member", "lead:write")).toBe(true);
    expect(can("member", "proposal:write")).toBe(true);
    expect(can("member", "ai:generate")).toBe(true);
    expect(can("member", "automation:manage")).toBe(false);
    expect(can("member", "team:manage")).toBe(false);
    expect(can("member", "billing:manage")).toBe(false);
    expect(can("member", "settings:workspace")).toBe(false);
    expect(can("member", "lead:delete")).toBe(false);
  });

  it("a manager can run automations and approvals but not billing or the team", () => {
    expect(can("manager", "automation:manage")).toBe(true);
    expect(can("manager", "approval:act")).toBe(true);
    expect(can("manager", "lead:delete")).toBe(true);
    expect(can("manager", "team:manage")).toBe(false);
    expect(can("manager", "billing:manage")).toBe(false);
  });

  it("an admin runs the workspace but cannot delete it", () => {
    expect(can("admin", "team:manage")).toBe(true);
    expect(can("admin", "settings:workspace")).toBe(true);
    expect(can("admin", "workspace:delete")).toBe(false);
  });

  it("denies unknown roles instead of defaulting to allow", () => {
    expect(can("superuser", "lead:read")).toBe(false);
    expect(can("", "lead:read")).toBe(false);
    expect(permissionsFor("nonsense")).toEqual([]);
  });

  it("scopes record ownership to the assignee for reps only", () => {
    const me = "user-1";
    const other = "user-2";
    expect(canEditOwnedRecord("member", me, me, "lead:write")).toBe(true);
    expect(canEditOwnedRecord("member", me, other, "lead:write")).toBe(false);
    expect(canEditOwnedRecord("member", me, null, "lead:write")).toBe(true);
    expect(canEditOwnedRecord("manager", me, other, "lead:write")).toBe(true);
    expect(canEditOwnedRecord("viewer", me, me, "lead:write")).toBe(false);
  });

  it("keeps the workspace-level helpers consistent", () => {
    expect(canManageWorkspace("admin")).toBe(true);
    expect(canManageWorkspace("manager")).toBe(false);
    expect(ROLES).toEqual(["owner", "admin", "manager", "member", "viewer"]);
  });
});

describe("notifications", () => {
  beforeEach(() => resetDatabaseForTests());

  it("notifies every member of the workspace except the actor", async () => {
    const { orgId, userId: actorId } = await seedOrg();
    const otherId = addMember(orgId, "member");
    notify({ organizationId: orgId, actorId, type: "system", title: "Something happened" });
    const mine = listNotifications(orgId, otherId);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("Something happened");
    expect(mine[0].type).toBe("system");
    expect(listNotifications(orgId, actorId)).toHaveLength(0);
  });

  it("delivers a targeted notification to one person only", async () => {
    const { orgId } = await seedOrg();
    const target = addMember(orgId, "member");
    const bystander = addMember(orgId, "viewer");
    notify({ organizationId: orgId, userId: target, type: "lead.assigned", title: "A lead is yours", href: "/leads/x" });
    expect(listNotifications(orgId, target)).toHaveLength(1);
    expect(listNotifications(orgId, bystander)).toHaveLength(0);
    expect(unreadCount(orgId, target)).toBe(1);
  });

  it("never leaks across workspaces", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    notify({ organizationId: a.orgId, userId: a.userId, type: "system", title: "A only" });
    expect(listNotifications(b.orgId, b.userId)).toHaveLength(0);
  });

  it("marks one as read, and only for its owner", async () => {
    const { orgId } = await seedOrg();
    const userA = addMember(orgId, "member");
    const userB = addMember(orgId, "member");
    notify({ organizationId: orgId, userId: userA, type: "system", title: "For A" });
    notify({ organizationId: orgId, userId: userB, type: "system", title: "For B" });
    const forA = listNotifications(orgId, userA)[0];

    // user B cannot mark user A's notification as read
    markRead(orgId, userB, forA.id);
    expect(unreadCount(orgId, userA)).toBe(1);

    markRead(orgId, userA, forA.id);
    expect(unreadCount(orgId, userA)).toBe(0);
  });

  it("marks everything as read at once", async () => {
    const { orgId } = await seedOrg();
    const user = addMember(orgId, "manager");
    for (let i = 0; i < 3; i++) notify({ organizationId: orgId, userId: user, type: "system", title: `n${i}` });
    expect(unreadCount(orgId, user)).toBe(3);
    markAllRead(orgId, user);
    expect(unreadCount(orgId, user)).toBe(0);
  });

  it("never throws when the write fails, so business operations survive", () => {
    expect(() => notify({ organizationId: "does-not-exist", type: "system", title: "boom" })).not.toThrow();
    expect(get<{ c: number }>("select count(*) as c from notifications")?.c ?? 0).toBe(0);
  });
});
