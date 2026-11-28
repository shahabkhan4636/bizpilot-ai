import { cookies } from "next/headers";
import { get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import {
  IMPERSONATION_CONFIRM_WORD as CONFIRM_WORD,
  IMPERSONATION_COOKIE as COOKIE_NAME,
  IMPERSONATION_MINUTES as LIFETIME_MINUTES,
  type ImpersonationMode as Mode,
} from "./impersonation-shared";

// Local aliases keep the rest of this module readable while the constants live in a
// browser-safe file.
type ImpersonationMode = Mode;
const IMPERSONATION_CONFIRM_WORD = CONFIRM_WORD;
const IMPERSONATION_COOKIE = COOKIE_NAME;
const IMPERSONATION_MINUTES = LIFETIME_MINUTES;

/**
 * Impersonation — the platform owner viewing a customer's workspace *as* that person.
 *
 * Design choices that matter:
 *
 * 1. **The admin's own session is never replaced.** The session cookie keeps pointing
 *    at the admin; a second cookie points at an `impersonation_sessions` row. Exiting
 *    is therefore deleting one cookie, and a bug can never strand the owner inside a
 *    customer's account (nor leave a customer holding admin powers).
 * 2. **Read-only by default.** Writes need the mode switched on with a typed
 *    confirmation word, are audited (`impersonated_write: true`) and notify the
 *    workspace owner. A support tool that can silently edit customer data is a
 *    liability, not a feature.
 * 3. **Expiring and revocable.** 60 minutes, extended explicitly; the row records
 *    start, end and why it ended.
 * 4. **Never against the platform owner's own account**, so the trail can never
 *    "explain" a change to the owner's workspace as impersonation.
 */

export {
  IMPERSONATION_COOKIE,
  IMPERSONATION_MINUTES,
  IMPERSONATION_CONFIRM_WORD,
  type ImpersonationMode,
} from "./impersonation-shared";

export type ImpersonationInfo = {
  sessionId: string;
  adminId: string;
  adminEmail: string;
  mode: ImpersonationMode;
  startedAt: string;
  expiresAt: string;
};

export type ImpersonationRow = {
  id: string;
  admin_id: string;
  target_user_id: string;
  organization_id: string;
  mode: ImpersonationMode;
  write_acknowledged_at: string | null;
  write_count: number;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  end_reason: string | null;
};

/* ------------------------------------------------------------------- cookies */

export async function readImpersonationId(): Promise<string | null> {
  const store = await cookies();
  return store.get(IMPERSONATION_COOKIE)?.value ?? null;
}

export async function setImpersonationCookie(id: string, expiresAt: string): Promise<void> {
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  store.delete(IMPERSONATION_COOKIE);
}

/* ------------------------------------------------------------------ database */

export function getImpersonation(id: string): ImpersonationRow | undefined {
  return get<ImpersonationRow>("select * from impersonation_sessions where id = ?", [id]);
}

export function isExpired(row: Pick<ImpersonationRow, "expires_at">, now: string = nowIso()): boolean {
  return new Date(row.expires_at).getTime() <= new Date(now).getTime();
}

/** An impersonation the caller may actually use: theirs, not ended, not expired. */
export function activeImpersonation(input: {
  sessionId: string | null;
  adminId: string;
  now?: string;
}): ImpersonationRow | null {
  if (!input.sessionId) return null;
  const row = getImpersonation(input.sessionId);
  if (!row) return null;
  if (row.admin_id !== input.adminId) return null; // someone else's cookie value
  if (row.ended_at) return null;
  if (isExpired(row, input.now ?? nowIso())) return null;
  return row;
}

export type StartImpersonationInput = {
  adminId: string;
  adminEmail: string;
  targetUserId: string;
  /** Workspace the impersonation starts in — recorded so the audit says where. */
  organizationId: string;
  now?: string;
};

export type StartImpersonationResult =
  | { ok: true; sessionId: string; expiresAt: string }
  | { ok: false; message: string };

export function startImpersonation(input: StartImpersonationInput): StartImpersonationResult {
  if (input.adminId === input.targetUserId) {
    return { ok: false, message: "You cannot impersonate yourself." };
  }

  const target = get<{ id: string; email: string; is_super_admin: number }>(
    "select id, email, is_super_admin from profiles where id = ?",
    [input.targetUserId]
  );
  if (!target) return { ok: false, message: "That user does not exist." };
  if (target.email.trim().toLowerCase() === input.adminEmail.trim().toLowerCase()) {
    return { ok: false, message: "You cannot impersonate the platform owner account." };
  }

  const membership = get<{ organization_id: string; role: string }>(
    "select organization_id, role from organization_members where user_id = ? and organization_id = ?",
    [input.targetUserId, input.organizationId]
  );
  if (!membership) return { ok: false, message: "That user is not a member of this workspace." };

  const org = get<{ suspended_at: string | null }>("select suspended_at from organizations where id = ?", [
    input.organizationId,
  ]);
  if (!org) return { ok: false, message: "That workspace does not exist." };
  if (org.suspended_at) {
    return { ok: false, message: "This workspace is suspended — unsuspend it before impersonating into it." };
  }

  const now = input.now ?? nowIso();
  const expiresAt = new Date(new Date(now).getTime() + IMPERSONATION_MINUTES * 60_000).toISOString();
  const id = newId();

  // One live impersonation per admin: starting a new one ends the previous one, so a
  // forgotten session cannot stay open in another tab indefinitely.
  run(
    "update impersonation_sessions set ended_at = ?, end_reason = 'replaced' where admin_id = ? and ended_at is null",
    [now, input.adminId]
  );
  run(
    `insert into impersonation_sessions
       (id, admin_id, target_user_id, organization_id, mode, write_count, started_at, expires_at)
     values (?,?,?,?,?,?,?,?)`,
    [id, input.adminId, input.targetUserId, input.organizationId, "read_only", 0, now, expiresAt]
  );

  audit({
    organizationId: input.organizationId,
    actorId: input.adminId,
    action: "impersonation.started",
    targetType: "user",
    targetId: input.targetUserId,
    metadata: { mode: "read_only", expiresAt, adminEmail: input.adminEmail },
  });

  return { ok: true, sessionId: id, expiresAt };
}

export function endImpersonation(input: {
  sessionId: string;
  adminId: string;
  reason?: string;
  notifyOwner?: boolean;
}): boolean {
  const row = getImpersonation(input.sessionId);
  if (!row || row.admin_id !== input.adminId) return false;
  if (row.ended_at) return true; // already ended: nothing to do, no error for a double click

  const now = nowIso();
  run("update impersonation_sessions set ended_at = ?, end_reason = ? where id = ?", [
    now,
    input.reason ?? "manual",
    input.sessionId,
  ]);
  audit({
    organizationId: row.organization_id,
    actorId: input.adminId,
    action: "impersonation.ended",
    targetType: "user",
    targetId: row.target_user_id,
    metadata: { mode: row.mode, writeCount: row.write_count, reason: input.reason ?? "manual" },
  });
  if (input.notifyOwner && row.write_count > 0) {
    notify({
      organizationId: row.organization_id,
      type: "system",
      level: "warning",
      title: "Support accessed your workspace in write mode",
      body: `${row.write_count} change(s) were made by the platform owner while viewing your workspace. The audit log records each one.`,
      href: "/settings/activity",
    });
  }
  return true;
}

/** Ends every live impersonation for an admin, used on logout. */
export function endAllForAdmin(adminId: string, reason = "logout"): number {
  const now = nowIso();
  const result = run(
    "update impersonation_sessions set ended_at = ?, end_reason = ? where admin_id = ? and ended_at is null",
    [now, reason, adminId]
  );
  return result.changes;
}

export type ModeResult = { ok: true } | { ok: false; message: string };

/**
 * Switches an existing impersonation to write mode.
 *
 * Requires the exact confirmation word, because "write mode" is the one control in
 * this feature that can change a customer's data, and a stray click must not reach it.
 */
export function setImpersonationMode(input: {
  sessionId: string;
  adminId: string;
  mode: ImpersonationMode;
  confirmation?: string | null;
}): ModeResult {
  const row = getImpersonation(input.sessionId);
  if (!row || row.admin_id !== input.adminId) return { ok: false, message: "That impersonation session is not yours." };
  if (row.ended_at) return { ok: false, message: "That impersonation session has already ended." };
  if (isExpired(row)) return { ok: false, message: "That impersonation session has expired. Start again." };

  if (input.mode === "write" && (input.confirmation ?? "").trim().toUpperCase() !== IMPERSONATION_CONFIRM_WORD) {
    return { ok: false, message: `Type ${IMPERSONATION_CONFIRM_WORD} to confirm you want to make real changes.` };
  }

  const now = nowIso();
  run("update impersonation_sessions set mode = ?, write_acknowledged_at = ? where id = ?", [
    input.mode,
    input.mode === "write" ? now : null,
    input.sessionId,
  ]);
  audit({
    organizationId: row.organization_id,
    actorId: input.adminId,
    action: "impersonation.mode_changed",
    targetType: "user",
    targetId: row.target_user_id,
    metadata: { mode: input.mode },
  });
  return { ok: true };
}

/**
 * Records a write performed while impersonating.
 *
 * Called from the authorisation gate (`requirePermission`), not from each action, so
 * a new action added later cannot forget to be audited. The workspace owner is
 * notified once per session, not once per click, so a legitimate support fix does not
 * spam them into ignoring the warning.
 */
export function recordImpersonatedWrite(input: {
  sessionId: string;
  adminId: string;
  organizationId: string;
  targetUserId: string;
  permission: string;
}): void {
  const row = getImpersonation(input.sessionId);
  if (!row || row.admin_id !== input.adminId || row.ended_at) return;

  const before = row.write_count;
  run("update impersonation_sessions set write_count = write_count + 1 where id = ?", [input.sessionId]);

  audit({
    organizationId: input.organizationId,
    actorId: input.adminId,
    action: "impersonated_write",
    targetType: "user",
    targetId: input.targetUserId,
    metadata: { impersonated_write: true, permission: input.permission, sessionId: input.sessionId },
  });

  if (before === 0) {
    notify({
      organizationId: input.organizationId,
      type: "system",
      level: "warning",
      title: "Support is making changes in your workspace",
      body: "The platform owner is currently in your workspace in write mode. Every change is recorded in the audit log.",
      href: "/settings/activity",
    });
  }
}
