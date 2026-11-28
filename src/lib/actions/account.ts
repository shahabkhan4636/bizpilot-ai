"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run, tx } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { requestAppUrl } from "@/lib/request-url";
import { requireWriteAuth } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { verifyPassword } from "@/lib/password";
import { isEmailConfigured } from "@/lib/email";
import { deliverEmail } from "@/lib/email-outbox";
import { issueVerificationToken } from "@/lib/email-verification";
import { rateLimit } from "@/lib/ratelimit";
import { clearSessionCookie } from "@/lib/session";
import { nowIso } from "@/lib/utils";

export type AccountState = { error?: string; notice?: string; link?: string } | null;

/** Sends (or hands over) a verification link for the signed-in account. */
export async function resendVerificationAction(_prev: AccountState, _form: FormData): Promise<AccountState> {
  // Deliberately `requireUser()`, not `requireWriteAuth()`: verification has to work
  // before onboarding finishes, so there may be no membership to gate on. The
  // impersonation case is refused by hand instead — an admin must not be able to mint
  // a verification token for a customer's mailbox.
  const user = await requireUser();
  if (user.impersonation) {
    return { error: "Stop impersonating to verify this account's email address." };
  }
  const limit = rateLimit(`verify:${user.id}`, 3, 600);
  if (!limit.allowed) return { error: "You already requested a link recently. Try again in a few minutes." };

  const { token, expiresAt } = issueVerificationToken(user.id, user.email);
  const link = `${await requestAppUrl()}/verify-email?token=${token}`;

  if (!isEmailConfigured()) {
    return {
      notice: "Email delivery is not configured, so nothing was sent. Use this link to verify your address:",
      link,
    };
  }
  const sent = await deliverEmail({
    to: user.email,
    subject: "Verify your email address for BizPilot AI",
    text: `Confirm your email address to finish setting up your account.\n\n${link}\n\nThis link expires on ${expiresAt}.`,
    kind: "verify_email",
    // No membership lookup here on purpose: a verification email must be sendable
    // before onboarding finishes, and the outbox row does not need a workspace.
    organizationId: null,
  });
  if (!sent.ok) return { error: `The email provider rejected the message: ${sent.message}` };
  return { notice: `Verification email sent to ${user.email}.` };
}

/**
 * Deletes the signed-in account.
 *
 * Safety rules, enforced here and not in the UI:
 *  • the current password must be supplied;
 *  • an owner cannot delete an account while other people are in the workspace
 *    (ownership has to be transferred first) — otherwise a whole team loses its
 *    data because one person left;
 *  • a workspace is deleted only when this user is its last member.
 */
export async function deleteAccountAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { user, membership } = await requireWriteAuth("account:delete");
  const password = String(form.get("password") ?? "");
  const confirmation = String(form.get("confirm") ?? "").trim().toUpperCase();
  if (confirmation !== "DELETE") return { error: 'Type DELETE in the confirmation box to continue.' };

  const row = get<{ password_hash: string | null }>("select password_hash from profiles where id = ?", [user.id]);
  if (!(await verifyPassword(password, row?.password_hash))) {
    return { error: "That password is not correct." };
  }

  const members = all<{ user_id: string; role: string }>(
    "select user_id, role from organization_members where organization_id = ?",
    [membership.organization_id]
  );
  const others = members.filter((m) => m.user_id !== user.id);
  if (membership.role === "owner" && others.length > 0) {
    return {
      error:
        "You are the owner of a workspace with other members. Transfer ownership (Settings → Team) or remove them before deleting your account.",
    };
  }

  const now = nowIso();
  tx(() => {
    if (others.length === 0) {
      // Last member: the workspace and everything in it goes with the account.
      run("delete from organizations where id = ?", [membership.organization_id]);
    } else {
      run("delete from organization_members where organization_id = ? and user_id = ?", [
        membership.organization_id,
        user.id,
      ]);
    }
    run("delete from profiles where id = ?", [user.id]);
    audit({
      organizationId: membership.organization_id,
      actorId: null,
      action: "account.deleted",
      targetType: "profile",
      targetId: user.id,
      metadata: { at: now },
    });
  });

  await clearSessionCookie();
  revalidatePath("/");
  redirect("/?deleted=1");
}
