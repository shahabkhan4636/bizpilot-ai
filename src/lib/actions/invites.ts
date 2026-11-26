"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createHash } from "node:crypto";
import { run, get } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { addDays, nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hashPassword, passwordProblems } from "@/lib/password";
import { createSession, setSessionCookie } from "@/lib/session";
import { getEffectivePlan } from "@/lib/plans";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { rateLimit } from "@/lib/ratelimit";
import { ValidationError, str, email as emailField, oneOf } from "@/lib/validate";

export type InviteState = {
  error?: string;
  notice?: string;
  /** Set when email delivery is unavailable, so a real link is still handed over. */
  link?: string;
} | null;

function sha256(v: string) {
  return createHash("sha256").update(v).digest("hex");
}

async function baseUrl(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  return process.env.NEXT_PUBLIC_APP_URL ?? `${proto}://${host}`;
}

export async function inviteMemberAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    if (membership.role !== "owner" && membership.role !== "admin") {
      return { error: "Only an owner or admin can invite people." };
    }

    const plan = getEffectivePlan(orgId);
    const seats = get<{ c: number }>("select count(*) as c from organization_members where organization_id = ?", [orgId])?.c ?? 0;
    const pending = get<{ c: number }>(
      "select count(*) as c from org_invites where organization_id = ? and accepted_at is null and expires_at > ?",
      [orgId, nowIso()]
    )?.c ?? 0;
    if (seats + pending >= plan.member_limit) {
      return {
        error: `The ${plan.name} plan includes ${plan.member_limit} seat(s); ${seats} used and ${pending} pending. Upgrade on the billing page to invite more people.`,
      };
    }

    const email = emailField(form.get("email")).toLowerCase();
    const role = oneOf(form.get("role"), "Role", ["member", "admin"] as const, "member");

    const already = get<{ id: string }>(
      `select m.id from organization_members m join profiles p on p.id = m.user_id
        where m.organization_id = ? and lower(p.email) = ?`,
      [orgId, email]
    );
    if (already) return { error: "That person is already a member of this workspace." };

    const existingInvite = get<{ id: string; expires_at: string }>(
      "select id, expires_at from org_invites where organization_id = ? and lower(email) = ? and accepted_at is null and expires_at > ?",
      [orgId, email, nowIso()]
    );
    if (existingInvite) {
      return { error: "An unexpired invitation for that address already exists. Let it expire or wait for them to accept." };
    }

    const token = newToken(32);
    run(
      `insert into org_invites (id, organization_id, email, role, token_hash, invited_by, expires_at, created_at)
       values (?,?,?,?,?,?,?,?)`,
      [newId(), orgId, email, role, sha256(token), user.id, addDays(7).toISOString(), nowIso()]
    );
    audit({ organizationId: orgId, actorId: user.id, action: "org.invite_created", metadata: { role } });
    // The settings page lists pending invitations, so it must not keep a stale list.
    revalidatePath("/settings");

    const link = `${await baseUrl()}/invite/${token}`;
    const sent = await sendEmail({
      to: email,
      subject: `You have been invited to ${membership.organization_name} on BizPilot AI`,
      text: `You have been invited to join "${membership.organization_name}" as ${role}.\n\nAccept the invitation (valid for 7 days):\n${link}\n\nIf you were not expecting this, ignore this email.`,
    });

    if (sent.ok) return { notice: `Invitation emailed to ${email} (valid 7 days).` };
    if (!isEmailConfigured()) {
      // No email provider: hand the real link to the inviter instead of pretending to send.
      return {
        notice: `Email delivery is not configured, so nothing was sent. The invitation exists — share this link with ${email} yourself:`,
        link,
      };
    }
    return { error: `The email provider rejected the message: ${sent.message}` };
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: e instanceof Error ? e.message : "Could not create the invitation." };
  }
}

export async function revokeInviteAction(form: FormData): Promise<void> {
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  if (membership.role !== "owner" && membership.role !== "admin") return;
  const id = String(form.get("invite_id") ?? "");
  run("delete from org_invites where id = ? and organization_id = ?", [id, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: "org.invite_revoked", metadata: { id } });
  revalidatePath("/settings");
}

/** Reads an invitation by raw token, returning only what the accept page needs. */
export async function inviteDetails(token: string) {
  const invite = get<{
    id: string; organization_id: string; email: string; role: string; expires_at: string; accepted_at: string | null;
  }>(
    "select id, organization_id, email, role, expires_at, accepted_at from org_invites where token_hash = ?",
    [sha256(token)]
  );
  if (!invite) return null;
  const org = get<{ name: string }>("select name from organizations where id = ?", [invite.organization_id]);
  const existingUser = get<{ id: string }>("select id from profiles where lower(email) = ?", [invite.email.toLowerCase()]);
  return {
    orgName: org?.name ?? "a workspace",
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expires_at,
    accepted: Boolean(invite.accepted_at),
    expired: new Date(invite.expires_at) < new Date(),
    hasAccount: Boolean(existingUser),
  };
}

/**
 * Accepts an invitation.
 *  - Existing account: the member is simply added to the workspace.
 *  - New account: a profile is created with the chosen password, then added.
 * Either way the invite is marked accepted and a session is started.
 */
export async function acceptInviteAction(_prev: InviteState, form: FormData): Promise<InviteState> {
  let redirectTo: string | null = null;
  try {
    const token = String(form.get("token") ?? "");
    if (!token) throw new ValidationError("The invitation token is missing.");
    const limit = rateLimit(`invite-accept:${sha256(token).slice(0, 12)}`, 10, 600);
    if (!limit.allowed) return { error: "Too many attempts on this invitation. Try again shortly." };

    const invite = get<{
      id: string; organization_id: string; email: string; role: string; expires_at: string; accepted_at: string | null;
    }>(
      "select id, organization_id, email, role, expires_at, accepted_at from org_invites where token_hash = ?",
      [sha256(token)]
    );
    if (!invite) throw new ValidationError("This invitation link is not valid.");
    if (invite.accepted_at) throw new ValidationError("This invitation has already been used.");
    if (new Date(invite.expires_at) < new Date()) throw new ValidationError("This invitation has expired. Ask for a new one.");

    const email = invite.email.toLowerCase();
    const existing = get<{ id: string }>("select id from profiles where lower(email) = ?", [email]);

    let userId: string;
    if (existing) {
      // Require the existing password so possession of the link alone cannot hijack an account.
      const { verifyPassword } = await import("@/lib/password");
      const password = String(form.get("password") ?? "");
      const row = get<{ password_hash: string | null }>("select password_hash from profiles where id = ?", [existing.id]);
      if (!(await verifyPassword(password, row?.password_hash))) {
        return { error: "An account already exists for this address. Enter its current password to join the workspace." };
      }
      userId = existing.id;
    } else {
      const fullName = str(form.get("full_name"), "Your name", { min: 2, max: 120 });
      const password = String(form.get("password") ?? "");
      const problems = passwordProblems(password);
      if (problems.length) throw new ValidationError(problems.join(" "));
      userId = newId();
      const now = nowIso();
      run(
        "insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)",
        [userId, email, await hashPassword(password), fullName, now, now]
      );
    }

    const alreadyMember = get("select id from organization_members where organization_id = ? and user_id = ?", [invite.organization_id, userId]);
    if (!alreadyMember) {
      run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
        newId(), invite.organization_id, userId, invite.role, nowIso(),
      ]);
    }
    run("update org_invites set accepted_at = ? where id = ?", [nowIso(), invite.id]);
    audit({ organizationId: invite.organization_id, actorId: userId, action: "org.invite_accepted", metadata: { role: invite.role } });

    const session = createSession(userId);
    await setSessionCookie(session.token, session.expiresAt);
    redirectTo = "/dashboard";
  } catch (e) {
    if (e instanceof ValidationError) return { error: e.message };
    return { error: e instanceof Error ? e.message : "Could not accept the invitation." };
  }
  redirect(redirectTo);
}
