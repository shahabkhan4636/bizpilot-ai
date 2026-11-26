"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { all, get, run, tx } from "@/lib/db";
import { requireAuth, requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { verifyPassword } from "@/lib/password";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import { issueVerificationToken } from "@/lib/email-verification";
import { rateLimit } from "@/lib/ratelimit";
import { clearSessionCookie } from "@/lib/session";
import { nowIso } from "@/lib/utils";

export type AccountState = { error?: string; notice?: string; link?: string } | null;

async function appUrl(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  return process.env.NEXT_PUBLIC_APP_URL ?? `${proto}://${host}`;
}

/** Sends (or hands over) a verification link for the signed-in account. */
export async function resendVerificationAction(_prev: AccountState, _form: FormData): Promise<AccountState> {
  const user = await requireUser();
  const limit = rateLimit(`verify:${user.id}`, 3, 600);
  if (!limit.allowed) return { error: "You already requested a link recently. Try again in a few minutes." };

  const { token, expiresAt } = issueVerificationToken(user.id, user.email);
  const link = `${await appUrl()}/verify-email?token=${token}`;

  if (!isEmailConfigured()) {
    return {
      notice: "Email delivery is not configured, so nothing was sent. Use this link to verify your address:",
      link,
    };
  }
  const sent = await sendEmail({
    to: user.email,
    subject: "Verify your email address for BizPilot AI",
    text: `Confirm your email address to finish setting up your account.\n\n${link}\n\nThis link expires on ${expiresAt}.`,
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
  const { user, membership } = await requireAuth();
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
