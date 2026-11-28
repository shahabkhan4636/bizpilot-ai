"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperAdmin, requireSuperAdminSession } from "@/lib/auth";
import { ValidationError, optionalStr, str } from "@/lib/validate";
import {
  applyWorkspacePlan,
  getWorkspace,
  suspendWorkspace,
  unsuspendWorkspace,
} from "@/lib/admin/workspaces";
import {
  clearImpersonationCookie,
  endImpersonation,
  setImpersonationCookie,
  setImpersonationMode,
  startImpersonation,
  type ImpersonationMode,
} from "@/lib/impersonation";

export type AdminWorkspaceState = { error?: string; notice?: string } | null;

function fail(e: unknown): AdminWorkspaceState {
  if (e instanceof ValidationError) return { error: e.message };
  if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
  if (e instanceof Error) return { error: e.message };
  return { error: "Something went wrong. Nothing was changed." };
}

/* ------------------------------------------------------- suspend / restore */

export async function suspendWorkspaceAction(
  _prev: AdminWorkspaceState,
  form: FormData
): Promise<AdminWorkspaceState> {
  let workspaceId = "";
  let outcome: AdminWorkspaceState = null;
  try {
    const admin = await requireSuperAdmin();
    workspaceId = str(form.get("organization_id"), "Workspace", { min: 4, max: 60 });
    const reason = str(form.get("reason"), "Reason", { min: 5, max: 500 });
    const result = suspendWorkspace({ organizationId: workspaceId, reason, actorId: admin.id });
    outcome = result.ok ? { notice: result.notice } : { error: result.message };
  } catch (e) {
    outcome = fail(e);
  }
  revalidatePath("/admin/workspaces");
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  // The re-render drops the form's local state, so a successful change is confirmed
  // through the URL — the same pattern the payment review uses.
  if (outcome && "notice" in outcome && workspaceId) redirect(`/admin/workspaces/${workspaceId}?done=suspended`);
  return outcome;
}

export async function unsuspendWorkspaceAction(
  _prev: AdminWorkspaceState,
  form: FormData
): Promise<AdminWorkspaceState> {
  let workspaceId = "";
  let outcome: AdminWorkspaceState = null;
  try {
    const admin = await requireSuperAdmin();
    workspaceId = str(form.get("organization_id"), "Workspace", { min: 4, max: 60 });
    const reason = str(form.get("reason"), "Reason", { min: 5, max: 500 });
    const result = unsuspendWorkspace({ organizationId: workspaceId, reason, actorId: admin.id });
    outcome = result.ok ? { notice: result.notice } : { error: result.message };
  } catch (e) {
    outcome = fail(e);
  }
  revalidatePath("/admin/workspaces");
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  if (outcome && "notice" in outcome && workspaceId) redirect(`/admin/workspaces/${workspaceId}?done=restored`);
  return outcome;
}

export async function applyWorkspacePlanAction(
  _prev: AdminWorkspaceState,
  form: FormData
): Promise<AdminWorkspaceState> {
  let workspaceId = "";
  let outcome: AdminWorkspaceState = null;
  try {
    const admin = await requireSuperAdmin();
    workspaceId = str(form.get("organization_id"), "Workspace", { min: 4, max: 60 });
    const planCode = str(form.get("plan_code"), "Plan", { min: 2, max: 40 });
    const result = applyWorkspacePlan({ organizationId: workspaceId, planCode, actorId: admin.id });
    outcome = result.ok ? { notice: result.notice } : { error: result.message };
  } catch (e) {
    outcome = fail(e);
  }
  revalidatePath("/admin/workspaces");
  revalidatePath(`/admin/workspaces/${workspaceId}`);
  revalidatePath("/admin");
  if (outcome && "notice" in outcome && workspaceId) redirect(`/admin/workspaces/${workspaceId}?done=plan`);
  return outcome;
}

/* ------------------------------------------------------------ impersonation */

/**
 * Starts viewing a customer's workspace as that person.
 *
 * Only the platform owner can reach this (the action is guarded), the target must be a
 * member of the named workspace, and the redirect lands on the customer's dashboard so
 * the admin sees what the customer sees — with the banner that the layout adds.
 */
export async function startImpersonationAction(form: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const userId = str(form.get("user_id"), "User", { min: 4, max: 60 });
  const organizationId = str(form.get("organization_id"), "Workspace", { min: 4, max: 60 });

  const workspace = getWorkspace(organizationId);
  if (!workspace) redirect(`/admin/workspaces?error=not-found`);

  const result = startImpersonation({
    adminId: admin.id,
    adminEmail: admin.email,
    targetUserId: userId,
    organizationId,
  });
  if (!result.ok) redirect(`/admin/workspaces/${organizationId}?impersonationError=${encodeURIComponent(result.message)}`);

  await setImpersonationCookie(result.sessionId, result.expiresAt);
  redirect("/dashboard");
}

/** Switches read-only ⇄ write. Write needs the typed confirmation word. */
export async function setImpersonationModeAction(
  _prev: AdminWorkspaceState,
  form: FormData
): Promise<AdminWorkspaceState> {
  try {
    const { admin, impersonation } = await requireSuperAdminSession();
    if (!impersonation) return { error: "You are not impersonating anyone." };
    const modeRaw = str(form.get("mode"), "Mode", { min: 4, max: 20 });
    if (modeRaw !== "read_only" && modeRaw !== "write") return { error: "Unknown mode." };
    const confirmation = optionalStr(form.get("confirmation"), 40);

    const result = setImpersonationMode({
      sessionId: impersonation.id,
      adminId: admin.id,
      mode: modeRaw as ImpersonationMode,
      confirmation,
    });
    if (!result.ok) return { error: result.message };
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/dashboard");
  revalidatePath("/leads");
  return {
    notice:
      "Write mode is on. Every change you make is audited as an impersonated write and the workspace owner is notified.",
  };
}

/** Leaves impersonation and returns to the workspace record. */
export async function endImpersonationAction(form: FormData): Promise<void> {
  const { admin, impersonation } = await requireSuperAdminSession();
  const returnTo = optionalStr(form.get("return_to"), 200) || "/admin/workspaces";
  if (impersonation) {
    endImpersonation({
      sessionId: impersonation.id,
      adminId: admin.id,
      reason: "manual",
      notifyOwner: true,
    });
    revalidatePath("/admin/workspaces");
    revalidatePath(`/admin/workspaces/${impersonation.organization_id}`);
  }
  await clearImpersonationCookie();
  redirect(returnTo.startsWith("/") ? returnTo : "/admin/workspaces");
}
