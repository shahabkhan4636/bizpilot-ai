import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { all, get, resetDatabaseForTests, run } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import {
  IMPERSONATION_CONFIRM_WORD,
  IMPERSONATION_MINUTES,
  activeImpersonation,
  endAllForAdmin,
  endImpersonation,
  isExpired,
  recordImpersonatedWrite,
  setImpersonationMode,
  startImpersonation,
} from "@/lib/impersonation";
import { isWritePermission, READ_ONLY_PERMISSIONS, PERMISSIONS } from "@/lib/permissions";

/**
 * Phase 5 — impersonation.
 *
 * These are the rules that make "view as the customer" safe rather than terrifying:
 *  - read-only by default, and switching to write needs a typed confirmation;
 *  - every write under impersonation is audited as `impersonated_write: true`;
 *  - the admin's own identity is never replaced, so exit always works;
 *  - sessions expire, and only the admin who started one can use it;
 *  - the platform owner's account can never be impersonated.
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

function seedAdmin(email = OWNER_EMAIL) {
  const now = nowIso();
  const id = newId();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    id,
    email,
    null,
    "Platform Owner",
    now,
    now,
  ]);
  return { id, email };
}

function seedWorkspace(ownerEmail = "customer@example.com", options: { suspended?: boolean } = {}) {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `ws-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId,
    ownerEmail,
    null,
    "Customer Owner",
    now,
    now,
  ]);
  run("insert into organizations (id, name, slug, suspended_at, created_at, updated_at) values (?,?,?,?,?,?)", [
    orgId,
    `Org ${slug}`,
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
  return { userId, orgId, slug, email: ownerEmail };
}

function start(adminId: string, adminEmail: string, targetUserId: string, organizationId: string) {
  const result = startImpersonation({ adminId, adminEmail, targetUserId, organizationId });
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe("starting an impersonation", () => {
  it("creates a read-only, expiring session and audits who/what/where", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);

    const row = get<{ mode: string; write_count: number; started_at: string; expires_at: string; ended_at: string | null }>(
      "select mode, write_count, started_at, expires_at, ended_at from impersonation_sessions where id = ?",
      [session.sessionId]
    );
    expect(row?.mode).toBe("read_only");
    expect(row?.write_count).toBe(0);
    expect(row?.ended_at).toBeNull();
    const minutes = (new Date(session.expiresAt).getTime() - new Date(row!.started_at).getTime()) / 60_000;
    expect(Math.round(minutes)).toBe(IMPERSONATION_MINUTES);

    const auditRow = get<{ action: string; metadata: string }>(
      "select action, metadata from audit_logs where action = 'impersonation.started' order by created_at desc limit 1"
    );
    expect(auditRow?.metadata).toContain("read_only");
  });

  it("refuses to impersonate yourself", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const result = startImpersonation({
      adminId: admin.id,
      adminEmail: admin.email,
      targetUserId: admin.id,
      organizationId: customer.orgId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/yourself/i);
  });

  it("never impersonates the platform owner account", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace("owner2@bizpilot.test");
    // The guard compares the target's address with the configured owner address, so
    // point "the owner" at this account and try to impersonate it.
    process.env.ADMIN_EMAIL = customer.email;
    const result = startImpersonation({
      adminId: admin.id,
      adminEmail: customer.email,
      targetUserId: customer.userId,
      organizationId: customer.orgId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/platform owner/i);
    expect(all("select id from impersonation_sessions").length).toBe(0);
  });

  it("refuses a user who is not a member of that workspace", () => {
    const admin = seedAdmin();
    const a = seedWorkspace("a@example.com");
    const b = seedWorkspace("b@example.com");
    const result = startImpersonation({
      adminId: admin.id,
      adminEmail: admin.email,
      targetUserId: a.userId,
      organizationId: b.orgId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/not a member/i);
  });

  it("refuses a suspended workspace", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace("customer@example.com", { suspended: true });
    const result = startImpersonation({
      adminId: admin.id,
      adminEmail: admin.email,
      targetUserId: customer.userId,
      organizationId: customer.orgId,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/suspended/i);
  });

  it("ends a previous live session when starting another (no forgotten sessions)", () => {
    const admin = seedAdmin();
    const first = seedWorkspace("first@example.com");
    const second = seedWorkspace("second@example.com");
    const one = start(admin.id, admin.email, first.userId, first.orgId);
    start(admin.id, admin.email, second.userId, second.orgId);
    const row = get<{ ended_at: string | null; end_reason: string | null }>(
      "select ended_at, end_reason from impersonation_sessions where id = ?",
      [one.sessionId]
    );
    expect(row?.ended_at).toBeTruthy();
    expect(row?.end_reason).toBe("replaced");
  });
});

describe("which session may be used", () => {
  it("accepts the admin's own live session", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    const row = activeImpersonation({ sessionId: session.sessionId, adminId: admin.id });
    expect(row?.id).toBe(session.sessionId);
  });

  it("refuses a session that belongs to another admin", () => {
    const admin = seedAdmin();
    const other = seedAdmin("other-admin@example.com");
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    expect(activeImpersonation({ sessionId: session.sessionId, adminId: other.id })).toBeNull();
  });

  it("refuses an ended session", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    endImpersonation({ sessionId: session.sessionId, adminId: admin.id });
    expect(activeImpersonation({ sessionId: session.sessionId, adminId: admin.id })).toBeNull();
  });

  it("refuses an expired session, and reports expiry correctly", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    run("update impersonation_sessions set expires_at = ? where id = ?", [
      new Date(Date.now() - 60_000).toISOString(),
      session.sessionId,
    ]);
    expect(activeImpersonation({ sessionId: session.sessionId, adminId: admin.id })).toBeNull();
    expect(isExpired({ expires_at: addDays(-1).toISOString() })).toBe(true);
  });

  it("refuses a cookie value that matches no row", () => {
    expect(activeImpersonation({ sessionId: newId(), adminId: newId() })).toBeNull();
    expect(activeImpersonation({ sessionId: null, adminId: newId() })).toBeNull();
  });
});

describe("write mode", () => {
  it("refuses write mode without the exact confirmation word", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);

    const missing = setImpersonationMode({ sessionId: session.sessionId, adminId: admin.id, mode: "write" });
    expect(missing.ok).toBe(false);
    const wrong = setImpersonationMode({
      sessionId: session.sessionId,
      adminId: admin.id,
      mode: "write",
      confirmation: "yes please",
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.message).toContain(IMPERSONATION_CONFIRM_WORD);
    expect(get<{ mode: string }>("select mode from impersonation_sessions where id = ?", [session.sessionId])?.mode).toBe(
      "read_only"
    );
  });

  it("accepts the word (any case) and records when it was acknowledged", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    const result = setImpersonationMode({
      sessionId: session.sessionId,
      adminId: admin.id,
      mode: "write",
      confirmation: IMPERSONATION_CONFIRM_WORD.toLowerCase(),
    });
    expect(result.ok).toBe(true);
    const row = get<{ mode: string; write_acknowledged_at: string | null }>(
      "select mode, write_acknowledged_at from impersonation_sessions where id = ?",
      [session.sessionId]
    );
    expect(row?.mode).toBe("write");
    expect(row?.write_acknowledged_at).toBeTruthy();
    expect(
      all("select id from audit_logs where action = 'impersonation.mode_changed'").length
    ).toBe(1);
  });

  it("refuses to change the mode of someone else's session", () => {
    const admin = seedAdmin();
    const other = seedAdmin("other@example.com");
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    const result = setImpersonationMode({
      sessionId: session.sessionId,
      adminId: other.id,
      mode: "write",
      confirmation: IMPERSONATION_CONFIRM_WORD,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses write mode on an ended or expired session", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    run("update impersonation_sessions set expires_at = ? where id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      session.sessionId,
    ]);
    const expired = setImpersonationMode({
      sessionId: session.sessionId,
      adminId: admin.id,
      mode: "write",
      confirmation: IMPERSONATION_CONFIRM_WORD,
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.message).toMatch(/expired/i);

    endImpersonation({ sessionId: session.sessionId, adminId: admin.id });
    const ended = setImpersonationMode({
      sessionId: session.sessionId,
      adminId: admin.id,
      mode: "write",
      confirmation: IMPERSONATION_CONFIRM_WORD,
    });
    expect(ended.ok).toBe(false);
    if (!ended.ok) expect(ended.message).toMatch(/ended/i);
  });
});

describe("auditing impersonated writes", () => {
  it("flags every write and notifies the workspace owner only once", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);

    const base = {
      sessionId: session.sessionId,
      adminId: admin.id,
      organizationId: customer.orgId,
      targetUserId: customer.userId,
    };
    recordImpersonatedWrite({ ...base, permission: "lead:write" });
    recordImpersonatedWrite({ ...base, permission: "document:upload" });

    const writes = all<{ metadata: string }>(
      "select metadata from audit_logs where action = 'impersonated_write' order by created_at asc"
    );
    expect(writes.length).toBe(2);
    expect(writes[0]?.metadata).toContain('"impersonated_write":true');
    expect(writes[1]?.metadata).toContain("document:upload");

    const row = get<{ write_count: number }>("select write_count from impersonation_sessions where id = ?", [
      session.sessionId,
    ]);
    expect(row?.write_count).toBe(2);

    const notifications = all<{ title: string }>(
      "select title from notifications where organization_id = ?",
      [customer.orgId]
    );
    expect(notifications.filter((n) => /making changes/i.test(n.title)).length).toBe(1);
  });

  it("does nothing for a session that is not the admin's", () => {
    const admin = seedAdmin();
    const other = seedAdmin("other@example.com");
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    recordImpersonatedWrite({
      sessionId: session.sessionId,
      adminId: other.id,
      organizationId: customer.orgId,
      targetUserId: customer.userId,
      permission: "lead:write",
    });
    expect(all("select id from audit_logs where action = 'impersonated_write'").length).toBe(0);
  });
});

describe("ending impersonation", () => {
  it("records when and why, and is safe to call twice", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    expect(endImpersonation({ sessionId: session.sessionId, adminId: admin.id })).toBe(true);
    expect(endImpersonation({ sessionId: session.sessionId, adminId: admin.id })).toBe(true); // double click
    const row = get<{ ended_at: string | null; end_reason: string | null }>(
      "select ended_at, end_reason from impersonation_sessions where id = ?",
      [session.sessionId]
    );
    expect(row?.ended_at).toBeTruthy();
    expect(row?.end_reason).toBe("manual");
    expect(all("select id from audit_logs where action = 'impersonation.ended'").length).toBe(1);
  });

  it("tells the owner afterwards if anything was written", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    recordImpersonatedWrite({
      sessionId: session.sessionId,
      adminId: admin.id,
      organizationId: customer.orgId,
      targetUserId: customer.userId,
      permission: "lead:write",
    });
    endImpersonation({ sessionId: session.sessionId, adminId: admin.id, notifyOwner: true });
    const notifications = all<{ title: string }>(
      "select title from notifications where organization_id = ?",
      [customer.orgId]
    );
    expect(notifications.some((n) => /write mode/i.test(n.title))).toBe(true);
  });

  it("refuses to end another admin's session", () => {
    const admin = seedAdmin();
    const other = seedAdmin("other@example.com");
    const customer = seedWorkspace();
    const session = start(admin.id, admin.email, customer.userId, customer.orgId);
    expect(endImpersonation({ sessionId: session.sessionId, adminId: other.id })).toBe(false);
  });

  it("ends everything for an admin on logout", () => {
    const admin = seedAdmin();
    const customer = seedWorkspace();
    start(admin.id, admin.email, customer.userId, customer.orgId);
    run(
      "insert into impersonation_sessions (id, admin_id, target_user_id, organization_id, mode, write_count, started_at, expires_at) values (?,?,?,?,?,?,?,?)",
      [newId(), admin.id, customer.userId, customer.orgId, "read_only", 0, nowIso(), addDays(1).toISOString()]
    );
    expect(endAllForAdmin(admin.id)).toBe(2);
    expect(
      all("select id from impersonation_sessions where admin_id = ? and ended_at is null", [admin.id]).length
    ).toBe(0);
  });
});

describe("permission classes", () => {
  it("treats every mutation as a write and every read as not-a-write", () => {
    expect(isWritePermission("lead:write")).toBe(true);
    expect(isWritePermission("lead:delete")).toBe(true);
    expect(isWritePermission("billing:manage")).toBe(true);
    expect(isWritePermission("team:manage")).toBe(true);
    expect(isWritePermission("lead:read")).toBe(false);
    expect(isWritePermission("analytics:read")).toBe(false);
    expect(isWritePermission("settings:profile")).toBe(false);
    // Every permission is classified, so a new one cannot fall through silently.
    expect(READ_ONLY_PERMISSIONS.every((p) => PERMISSIONS.includes(p))).toBe(true);
  });
});
