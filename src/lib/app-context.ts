import { requireAuth } from "./auth";
import { can, canManageTeam, canManageWorkspace, isReadOnly, type Permission } from "./permissions";
import { getEffectivePlan, subscriptionIsUsable, leadCount, usageThisMonth } from "./plans";
import { get } from "./db";
import { unreadCount } from "./notifications";

export type AppContext = Awaited<ReturnType<typeof loadAppContext>>;

/** Everything a signed-in page needs: identity, plan, usage and trial state. */
export async function loadAppContext() {
  const { user, membership } = await requireAuth();
  const plan = getEffectivePlan(membership.organization_id);
  const sub = get<{ status: string; trial_ends_at: string | null; billing_cycle: string; current_period_end: string | null; cancel_at_period_end: number }>(
    "select status, trial_ends_at, billing_cycle, current_period_end, cancel_at_period_end from subscriptions where organization_id = ?",
    [membership.organization_id]
  );
  const trialDaysLeft =
    sub?.status === "trialing" && sub.trial_ends_at
      ? Math.max(0, Math.ceil((new Date(sub.trial_ends_at).getTime() - Date.now()) / 86_400_000))
      : null;

  return {
    user,
    membership,
    orgId: membership.organization_id,
    plan,
    subscription: sub ?? null,
    subscribed: subscriptionIsUsable(membership.organization_id),
    trialDaysLeft,
    usage: {
      leads: leadCount(membership.organization_id),
      aiThisMonth: usageThisMonth(membership.organization_id, "ai_generation"),
    },
    displayName: user.full_name ?? user.email,
    /** Team administration (invite / remove / re-role). Owner and admin only. */
    canManage: canManageTeam(membership.role),
    canManageWorkspace: canManageWorkspace(membership.role),
    readOnly: isReadOnly(membership.role),
    unreadNotifications: unreadCount(membership.organization_id, user.id),
    /** Capability check usable directly in a server component. */
    can: (permission: Permission) => can(membership.role, permission),
  };
}
