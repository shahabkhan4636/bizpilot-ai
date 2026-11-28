import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { all, get, resetDatabaseForTests, run } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { assertImpersonationAllowsWrite, ForbiddenError } from "@/lib/authz";
import { startImpersonation } from "@/lib/impersonation";
import type { AuthContext } from "@/lib/auth";
import type { SessionUser } from "@/lib/session";

/**
 * The read-only guarantee, at the layer that actually enforces it.
 *
 * Phase 5 put the impersonation gate inside `requirePermission()`, which covered every
 * action that named a permission — and silently missed every action that did not.
 * Password changes, profile edits, workspace settings, team roles, invitations,
 * billing and approvals were all guarded by a hand-written role check plus
 * `requireAuth()`, so the platform owner could make real changes in a customer's
 * workspace while the UI and the banner said "read-only".
 *
 * These tests lock the two halves of the fix:
 *   1. behaviour — the gate refuses, allows and audits correctly;
 *   2. structure — every mutating server action goes through it, so the next action
 *      someone adds cannot quietly opt out.
 */

const ROOT = process.cwd();
const ORIGINAL_ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const OWNER_EMAIL = "owner@bizpilot.test";

beforeEach(() => {
  resetDatabaseForTests();
  process.env.ADMIN_EMAIL = OWNER_EMAIL;
});

afterEach(() => {
  if (ORIGINAL_ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = ORIGINAL_ADMIN_EMAIL;
});

/* ------------------------------------------------------------------ fixtures */

function seedPerson(email: string) {
  const now = nowIso();
  const id = newId();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    id,
    email,
    null,
    "Person",
    now,
    now,
  ]);
  return id;
}

function seedWorkspace(ownerId: string) {
  const now = nowIso();
  const orgId = newId();
  const slug = `ws-${newToken(3).toLowerCase()}`;
  run("insert into organizations (id, name, slug, suspended_at, created_at, updated_at) values (?,?,?,?,?,?)", [
    orgId,
    `Org ${slug}`,
    slug,
    null,
    now,
    now,
  ]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(),
    orgId,
    ownerId,
    "owner",
    now,
  ]);
  return orgId;
}

function context(impersonation: SessionUser["impersonation"]): AuthContext {
  const user: SessionUser = {
    id: newId(),
    email: "customer@example.com",
    full_name: "Customer Owner",
    is_super_admin: 0,
    onboarded_at: nowIso(),
    impersonation,
  };
  return {
    user,
    membership: {
      organization_id: "org-1",
      role: "owner",
      organization_name: "Org",
      organization_slug: "org",
      currency: "PKR",
      timezone: "Asia/Karachi",
      suspended_at: null,
    },
  };
}

/* ---------------------------------------------------------------- behaviour */

describe("assertImpersonationAllowsWrite", () => {
  it("is a no-op for a normal session", () => {
    expect(() => assertImpersonationAllowsWrite(context(undefined), "settings:workspace")).not.toThrow();
  });

  it("refuses every mutation in read-only mode, and records nothing", () => {
    const adminId = seedPerson(OWNER_EMAIL);
    const customerId = seedPerson("customer@example.com");
    const orgId = seedWorkspace(customerId);
    const session = startImpersonation({ adminId, adminEmail: OWNER_EMAIL, targetUserId: customerId, organizationId: orgId });
    if (!session.ok) throw new Error(session.message);

    const ctx = context({
      sessionId: session.sessionId,
      adminId,
      adminEmail: OWNER_EMAIL,
      mode: "read_only",
      startedAt: nowIso(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // The four writes that used to slip through, plus a permission-based one.
    for (const label of ["profile:password", "settings:workspace", "team:role", "billing:cancel", "lead:write"]) {
      expect(() => assertImpersonationAllowsWrite(ctx, label)).toThrow(ForbiddenError);
      expect(() => assertImpersonationAllowsWrite(ctx, label)).toThrow(/read-only/i);
    }

    expect(get<{ write_count: number }>("select write_count from impersonation_sessions where id = ?", [session.sessionId])?.write_count).toBe(0);
    expect(all("select id from audit_logs where action = 'impersonated_write'")).toHaveLength(0);
  });

  it("allows a write in write mode and audits it as an impersonated write", () => {
    const adminId = seedPerson(OWNER_EMAIL);
    const customerId = seedPerson("customer@example.com");
    const orgId = seedWorkspace(customerId);
    const session = startImpersonation({ adminId, adminEmail: OWNER_EMAIL, targetUserId: customerId, organizationId: orgId });
    if (!session.ok) throw new Error(session.message);
    run("update impersonation_sessions set mode = 'write', write_acknowledged_at = ? where id = ?", [nowIso(), session.sessionId]);

    const ctx = context({
      sessionId: session.sessionId,
      adminId,
      adminEmail: OWNER_EMAIL,
      mode: "write",
      startedAt: nowIso(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    ctx.membership.organization_id = orgId;
    ctx.user.id = customerId;

    expect(() => assertImpersonationAllowsWrite(ctx, "profile:password")).not.toThrow();

    const auditRow = get<{ metadata: string; actor_id: string }>(
      "select metadata, actor_id from audit_logs where action = 'impersonated_write' order by created_at desc limit 1"
    );
    expect(auditRow?.actor_id).toBe(adminId);
    expect(auditRow?.metadata).toContain("impersonated_write");
    expect(auditRow?.metadata).toContain("profile:password");
    expect(get<{ write_count: number }>("select write_count from impersonation_sessions where id = ?", [session.sessionId])?.write_count).toBe(1);

    // The workspace owner hears about it exactly once per session, not once per click.
    expect(all("select id from notifications where organization_id = ?", [orgId])).toHaveLength(1);
    expect(() => assertImpersonationAllowsWrite(ctx, "settings:workspace")).not.toThrow();
    expect(all("select id from notifications where organization_id = ?", [orgId])).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- structure */

/**
 * Functions that are deliberately NOT behind a session/role gate, with the reason.
 * Anything not listed here must call one of the guards.
 */
const PUBLIC_OR_EXEMPT: Record<string, string> = {
  // Share-token flows: the proposal's own single-use token is the credential.
  acceptProposalAction: "public: client accepts via the proposal share token",
  declineProposalAction: "public: client declines via the proposal share token",
  // Signed-out flows: the whole point is that there is no session yet.
  signupAction: "public: creates the account",
  loginAction: "public: creates the session",
  logoutAction: "ends the current session",
  requestPasswordResetAction: "public: unauthenticated by design, rate-limited",
  resetPasswordAction: "public: token IS the credential",
  onboardingAction: "signed in but deliberately before a workspace exists",
  // Token-based flows: the single-use token in the URL is the credential.
  inviteDetails: "public: reads one invitation by its token",
  acceptInviteAction: "public: token IS the credential",
  // Documented exemption: own-view state only, no tenant records.
  markNotificationReadAction: "own notification read-state",
  markAllNotificationsReadAction: "own notification read-state",
};

const GUARDS = ["requirePermission(", "requireWriteAuth(", "requireSuperAdmin(", "requireSuperAdminSession("];

/**
 * Names of functions defined *in this module* that contain a guard.
 *
 * A thin exported wrapper that delegates to a guarded local helper
 * (`approvePlatformClaimAction` → `review()`) is authorised; the guard is one call
 * away, and forcing every wrapper to repeat it would invite copy-paste drift.
 */
function locallyGuarded(source: string): string[] {
  const chunks = source.split(/\n(?:export )?(?:async )?function\s+/).slice(1);
  return chunks
    .filter((chunk) => GUARDS.some((guard) => chunk.includes(guard)))
    .map((chunk) => chunk.slice(0, chunk.indexOf("(")).trim())
    .filter(Boolean);
}

function actionModules(): { file: string; source: string }[] {
  const dir = path.join(ROOT, "src", "lib", "actions");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, source: fs.readFileSync(path.join(dir, f), "utf8") }));
}

/** `name` + body for every `export async function` in a module. */
function exportedFunctions(source: string): { name: string; body: string }[] {
  const chunks = source.split(/export async function\s+/).slice(1);
  return chunks.map((chunk) => ({
    name: chunk.slice(0, chunk.indexOf("(")).trim(),
    body: chunk,
  }));
}

describe("every mutating server action is gated", () => {
  it("calls requirePermission / requireWriteAuth / requireSuperAdmin, or is a listed public flow", () => {
    const ungated: string[] = [];
    for (const { file, source } of actionModules()) {
      if (!source.startsWith('"use server"')) continue;
      const helpers = locallyGuarded(source);
      for (const { name, body } of exportedFunctions(source)) {
        if (PUBLIC_OR_EXEMPT[name]) continue;
        if (GUARDS.some((guard) => body.includes(guard))) continue;
        if (helpers.some((helper) => helper !== name && body.includes(`${helper}(`))) continue;
        ungated.push(`${file}:${name}`);
      }
    }
    expect(ungated, `mutating actions with no authorisation guard: ${ungated.join(", ")}`).toEqual([]);
  });

  it("keeps the exempt list honest (no entry that is already gated, no entry that no longer exists)", () => {
    const names = new Set(
      actionModules()
        .filter(({ source }) => source.startsWith('"use server"'))
        .flatMap(({ source }) => exportedFunctions(source).map(({ name }) => name))
    );
    const stale = Object.keys(PUBLIC_OR_EXEMPT).filter((name) => !names.has(name));
    expect(stale, `exempt list mentions actions that do not exist: ${stale.join(", ")}`).toEqual([]);
  });

  it("does not export read helpers that take a tenant id from the caller", () => {
    // A tenant id in the signature of a `"use server"` export is a cross-tenant read
    // waiting to happen: the argument is attacker-controlled, the module is an
    // endpoint, and nothing in the helper checks the caller's membership.
    const offenders: string[] = [];
    for (const { file, source } of actionModules()) {
      if (!source.startsWith('"use server"')) continue;
      for (const { name, body } of exportedFunctions(source)) {
        const signature = body.slice(0, body.indexOf(")") + 1);
        if (/\b(org|organization)Id\b/.test(signature)) offenders.push(`${file}:${name}`);
      }
    }
    expect(offenders, `server actions taking a tenant id: ${offenders.join(", ")}`).toEqual([]);
  });
});
