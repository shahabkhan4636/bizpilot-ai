"use server";

import { revalidatePath } from "next/cache";
import { run, get } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { hashPassword, verifyPassword, passwordProblems } from "@/lib/password";
import { getEffectivePlan } from "@/lib/plans";
import { ValidationError, str, email as emailField, optionalStr, oneOf } from "@/lib/validate";

export type SettingsState = { error?: string; notice?: string } | null;

function handle(e: unknown): SettingsState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

export async function updateProfileAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  try {
    const { user } = await requireAuth();
    const fullName = str(form.get("full_name"), "Your name", { min: 2, max: 120 });
    run("update profiles set full_name = ?, updated_at = ? where id = ?", [fullName, nowIso(), user.id]);
    audit({ actorId: user.id, action: "profile.update" });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/settings");
  return { notice: "Profile updated." };
}

export async function changePasswordAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  try {
    const { user } = await requireAuth();
    const current = String(form.get("current_password") ?? "");
    const next = String(form.get("new_password") ?? "");
    const confirm = String(form.get("confirm_password") ?? "");
    if (next !== confirm) throw new ValidationError("The new passwords do not match.");
    const problems = passwordProblems(next);
    if (problems.length) throw new ValidationError(problems.join(" "));

    const row = get<{ password_hash: string | null }>("select password_hash from profiles where id = ?", [user.id]);
    const ok = await verifyPassword(current, row?.password_hash);
    if (!ok) return { error: "Your current password is incorrect." };

    run("update profiles set password_hash = ?, updated_at = ? where id = ?", [await hashPassword(next), nowIso(), user.id]);
    // Keep the current session, drop the rest.
    audit({ actorId: user.id, action: "profile.password_changed" });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/settings");
  return { notice: "Password changed. Other sessions keep working until they expire — sign in again elsewhere to refresh." };
}

export async function updateWorkspaceAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  try {
    const { user, membership } = await requireAuth();
    if (membership.role !== "owner" && membership.role !== "admin") return { error: "Only an owner or admin can change workspace settings." };
    const name = str(form.get("name"), "Workspace name", { min: 2, max: 120 });
    const timezone = optionalStr(form.get("timezone"), 60) || "UTC";
    const currency = oneOf(form.get("currency"), "Currency", ["USD", "PKR", "GBP", "EUR", "AED", "CAD", "AUD", "INR"] as const, "USD");
    const businessType = optionalStr(form.get("business_type"), 80) || null;
    const website = optionalStr(form.get("website"), 200) || null;
    const phone = optionalStr(form.get("phone"), 40) || null;

    run(
      "update organizations set name = ?, timezone = ?, currency = ?, business_type = ?, website = ?, phone = ?, updated_at = ? where id = ?",
      [name, timezone, currency, businessType, website, phone, nowIso(), membership.organization_id]
    );
    audit({ organizationId: membership.organization_id, actorId: user.id, action: "org.update" });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/settings");
  return { notice: "Workspace settings saved." };
}

/** Adds an existing account to this workspace, respecting the plan's member limit. */
export async function inviteMemberAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    if (membership.role !== "owner" && membership.role !== "admin") return { error: "Only an owner or admin can invite members." };

    const plan = getEffectivePlan(orgId);
    const count = get<{ c: number }>("select count(*) as c from organization_members where organization_id = ?", [orgId])?.c ?? 0;
    if (count >= plan.member_limit) {
      return { error: `The ${plan.name} plan allows ${plan.member_limit} member(s). Upgrade on the billing page to add more.` };
    }

    const email = emailField(form.get("email")).toLowerCase();
    const role = oneOf(form.get("role"), "Role", ["member", "admin"] as const, "member");

    const target = get<{ id: string; email: string }>("select id, email from profiles where lower(email) = ?", [email]);
    if (!target) {
      return {
        error:
          "No account exists for that email yet. Ask them to sign up first, then add them here — invitations by email require the email provider to be configured.",
      };
    }
    if (get("select id from organization_members where organization_id = ? and user_id = ?", [orgId, target.id])) {
      return { error: "That person is already a member of this workspace." };
    }

    run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
      newId(), orgId, target.id, role, nowIso(),
    ]);
    audit({ organizationId: orgId, actorId: user.id, action: "org.member_added", metadata: { role } });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/settings");
  return { notice: "Member added to the workspace." };
}

export async function updateMemberRoleAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    if (membership.role !== "owner") return { error: "Only the owner can change roles." };
    const memberId = str(form.get("user_id"), "Member", { min: 4 });
    const role = oneOf(form.get("role"), "Role", ["member", "admin", "owner"] as const, "member");
    if (memberId === user.id && role !== "owner") return { error: "You cannot demote yourself while you are the owner." };
    run("update organization_members set role = ? where organization_id = ? and user_id = ?", [role, orgId, memberId]);
    audit({ organizationId: orgId, actorId: user.id, action: "org.role_changed", metadata: { role } });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/settings");
  return { notice: "Role updated." };
}

export async function removeMemberAction(form: FormData): Promise<void> {
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  if (membership.role !== "owner" && membership.role !== "admin") return;
  const memberId = String(form.get("user_id") ?? "");
  if (memberId === user.id) return;
  run("delete from organization_members where organization_id = ? and user_id = ?", [orgId, memberId]);
  audit({ organizationId: orgId, actorId: user.id, action: "org.member_removed" });
  revalidatePath("/settings");
}
