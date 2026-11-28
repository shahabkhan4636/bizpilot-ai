import { all, get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { audit, logActivity } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { isPlatformOwnerWorkspace } from "@/lib/plans";
import { deliverEmail } from "@/lib/email-outbox";

/**
 * Admin operations on other people's workspaces.
 *
 * Kept out of the server actions so the rules are testable without a browser: these
 * are the only functions in the product that may change a customer's access, and each
 * one is audited with a reason. Nothing here trusts a form value for identity — the
 * caller passes the admin id it verified.
 */

export type WorkspaceListRow = {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  suspended_at: string | null;
  suspension_reason: string | null;
  plan_code: string | null;
  plan_name: string | null;
  status: string | null;
  billing_cycle: string | null;
  current_period_end: string | null;
  members: number;
  leads: number;
  owner_email: string | null;
  founding: number;
};

export type WorkspaceListInput = {
  search?: string;
  plan?: string;
  status?: "all" | "active" | "suspended" | "at_limit";
  page?: number;
  perPage?: number;
};

const PER_PAGE_DEFAULT = 25;

/** One page of workspaces, filtered in SQL (never by loading everything and filtering in JS). */
export function listWorkspaces(input: WorkspaceListInput = {}): { rows: WorkspaceListRow[]; total: number; page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(5, input.perPage ?? PER_PAGE_DEFAULT));
  const page = Math.max(1, input.page ?? 1);
  const where: string[] = [];
  const params: (string | number)[] = [];

  const search = (input.search ?? "").trim();
  if (search) {
    where.push("(lower(o.name) like ? or lower(o.slug) like ? or lower(coalesce(p.email,'')) like ?)");
    const like = `%${search.toLowerCase()}%`;
    params.push(like, like, like);
  }
  if (input.plan && input.plan !== "all") {
    where.push("coalesce(s.plan_code, '') = ?");
    params.push(input.plan);
  }
  if (input.status === "suspended") where.push("o.suspended_at is not null");
  if (input.status === "active") where.push("o.suspended_at is null");
  if (input.status === "at_limit") {
    // At or over the plan's lead limit — the customers most likely to need a call.
    where.push("(select count(*) from leads l where l.organization_id = o.id and l.deleted_at is null) >= coalesce(pl.lead_limit, 0)");
  }

  const from = `
    from organizations o
    left join subscriptions s on s.organization_id = o.id
    left join plans pl on pl.code = s.plan_code
    left join (
      select m.organization_id, p.email,
             row_number() over (partition by m.organization_id order by m.created_at asc) as rn
        from organization_members m join profiles p on p.id = m.user_id
    ) owner on owner.organization_id = o.id and owner.rn = 1
    left join profiles p on p.email = owner.email
    where ${where.length ? where.join(" and ") : "1 = 1"}`;

  const total = Number(get<{ c: number }>(`select count(*) as c ${from}`, params)?.c ?? 0);

  const rows = all<WorkspaceListRow>(
    `select o.id, o.name, o.slug, o.created_at, o.suspended_at, o.suspension_reason,
            s.plan_code, pl.name as plan_name, s.status, s.billing_cycle, s.current_period_end,
            (select count(*) from organization_members m2 where m2.organization_id = o.id) as members,
            (select count(*) from leads l2 where l2.organization_id = o.id and l2.deleted_at is null) as leads,
            owner.email as owner_email,
            (select count(*) from founding_memberships f where f.organization_id = o.id) as founding
       ${from}
      order by o.created_at desc
      limit ? offset ?`,
    [...params, perPage, (page - 1) * perPage]
  );

  return { rows, total, page, perPage };
}

export type WorkspaceDetail = WorkspaceListRow & {
  currency: string;
  timezone: string;
  suspended_by_email: string | null;
  leads_limit: number | null;
  ai_limit: number | null;
  ai_used: number | null;
};

export function getWorkspace(id: string): WorkspaceDetail | undefined {
  return get<WorkspaceDetail>(
    `select o.id, o.name, o.slug, o.created_at, o.suspended_at, o.suspension_reason,
            o.currency, o.timezone,
            (select p.email from profiles p where p.id = o.suspended_by) as suspended_by_email,
            s.plan_code, pl.name as plan_name, s.status, s.billing_cycle, s.current_period_end,
            pl.lead_limit as leads_limit, pl.ai_generation_limit as ai_limit,
            (select count(*) from organization_members m2 where m2.organization_id = o.id) as members,
            (select count(*) from leads l2 where l2.organization_id = o.id and l2.deleted_at is null) as leads,
            (select coalesce(sum(u.quantity), 0) from usage_records u
              where u.organization_id = o.id and u.metric = 'ai_generation') as ai_used,
            (select p.email from profiles p
              join organization_members m3 on m3.user_id = p.id
             where m3.organization_id = o.id order by m3.created_at asc limit 1) as owner_email,
            (select count(*) from founding_memberships f where f.organization_id = o.id) as founding
       from organizations o
       left join subscriptions s on s.organization_id = o.id
       left join plans pl on pl.code = s.plan_code
      where o.id = ?`,
    [id]
  );
}

export type AdminOutcome = { ok: true; notice: string } | { ok: false; message: string };

/**
 * Suspends a workspace: no writes anywhere, reason stored, owner told.
 *
 * Refuses the platform owner's own workspace — locking yourself out of your own
 * product through the support tool is not a recoverable mistake, it is an outage.
 */
export function suspendWorkspace(input: { organizationId: string; reason: string; actorId: string }): AdminOutcome {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, message: "Give a reason (at least 5 characters) — the customer will read it." };

  const org = get<{ id: string; name: string; suspended_at: string | null; owner_email: string | null }>(
    `select o.id, o.name, o.suspended_at,
            (select p.email from profiles p join organization_members m on m.user_id = p.id
              where m.organization_id = o.id order by m.created_at asc limit 1) as owner_email
       from organizations o where o.id = ?`,
    [input.organizationId]
  );
  if (!org) return { ok: false, message: "That workspace does not exist." };
  if (isPlatformOwnerWorkspace(org.id)) {
    return { ok: false, message: "Refused: this is the platform owner's own workspace." };
  }
  if (org.suspended_at) return { ok: false, message: "That workspace is already suspended." };

  const now = nowIso();
  run("update organizations set suspended_at = ?, suspension_reason = ?, suspended_by = ?, updated_at = ? where id = ?", [
    now,
    reason,
    input.actorId,
    now,
    org.id,
  ]);

  audit({
    organizationId: org.id,
    actorId: input.actorId,
    action: "admin.workspace_suspended",
    targetType: "organization",
    targetId: org.id,
    metadata: { reason },
  });
  logActivity({
    organizationId: org.id,
    actorId: input.actorId,
    entityType: "organization",
    entityId: org.id,
    action: "workspace.suspended",
    summary: `Workspace suspended by the platform owner: ${reason}`,
  });
  notify({
    organizationId: org.id,
    type: "system",
    level: "danger",
    title: "Your workspace has been suspended",
    body: `Reason: ${reason}. Contact support to restore access.`,
    href: "/billing",
  });
  if (org.owner_email) {
    // Queued through the outbox: with no provider key it waits instead of vanishing.
    deliverEmail({
      to: org.owner_email,
      subject: `Your BizPilot workspace ${org.name} has been suspended`,
      text: `Your workspace "${org.name}" has been suspended.\n\nReason: ${reason}\n\nReply to this email once it is resolved and we will restore access.\n\n— BizPilot AI`,
      kind: "account_email",
      organizationId: org.id,
    });
  }

  return { ok: true, notice: `Suspended. The customer sees: “${reason}”.` };
}

export function unsuspendWorkspace(input: { organizationId: string; reason: string; actorId: string }): AdminOutcome {
  const reason = input.reason.trim();
  if (reason.length < 5) return { ok: false, message: "Give a reason (at least 5 characters) — it goes in the audit log." };

  const org = get<{ id: string; name: string; suspended_at: string | null; owner_email: string | null }>(
    `select o.id, o.name, o.suspended_at,
            (select p.email from profiles p join organization_members m on m.user_id = p.id
              where m.organization_id = o.id order by m.created_at asc limit 1) as owner_email
       from organizations o where o.id = ?`,
    [input.organizationId]
  );
  if (!org) return { ok: false, message: "That workspace does not exist." };
  if (!org.suspended_at) return { ok: false, message: "That workspace is not suspended." };

  const now = nowIso();
  run(
    "update organizations set suspended_at = null, suspension_reason = null, suspended_by = null, updated_at = ? where id = ?",
    [now, org.id]
  );

  audit({
    organizationId: org.id,
    actorId: input.actorId,
    action: "admin.workspace_unsuspended",
    targetType: "organization",
    targetId: org.id,
    metadata: { reason, previousReason: org.suspended_at },
  });
  logActivity({
    organizationId: org.id,
    actorId: input.actorId,
    entityType: "organization",
    entityId: org.id,
    action: "workspace.unsuspended",
    summary: `Workspace restored by the platform owner: ${reason}`,
  });
  notify({
    organizationId: org.id,
    type: "system",
    level: "success",
    title: "Your workspace is active again",
    body: reason,
    href: "/dashboard",
  });
  if (org.owner_email) {
    deliverEmail({
      to: org.owner_email,
      subject: `Your BizPilot workspace ${org.name} is active again`,
      text: `Good news — access to "${org.name}" has been restored.\n\nNote from support: ${reason}\n\n— BizPilot AI`,
      kind: "account_email",
      organizationId: org.id,
    });
  }

  return { ok: true, notice: "Workspace restored and the owner has been told." };
}

/** Manual plan assignment (support/QA). Never charges anything — it is not a sale. */
export function applyWorkspacePlan(input: { organizationId: string; planCode: string; actorId: string }): AdminOutcome {
  const plan = get<{ code: string; name: string }>("select code, name from plans where code = ?", [input.planCode]);
  if (!plan) return { ok: false, message: "Unknown plan code." };

  const existing = get<{ id: string; plan_code: string }>(
    "select id, plan_code from subscriptions where organization_id = ?",
    [input.organizationId]
  );
  const now = nowIso();
  if (existing) {
    run("update subscriptions set plan_code = ?, updated_at = ? where organization_id = ?", [plan.code, now, input.organizationId]);
  } else {
    run(
      "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, created_at, updated_at) values (?,?,?,?,?,?,?)",
      [newId(), input.organizationId, plan.code, "active", "monthly", now, now]
    );
  }

  audit({
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "admin.plan_assigned",
    targetType: "organization",
    targetId: input.organizationId,
    metadata: { planCode: plan.code, previousPlanCode: existing?.plan_code ?? null },
  });
  return { ok: true, notice: `Plan set to ${plan.name}. No charge was made.` };
}

/** Members of a workspace, for the detail page and the impersonation buttons. */
export function listWorkspaceMembers(organizationId: string) {
  return all<{ id: string; email: string; full_name: string | null; role: string; created_at: string; last_session_at: string | null }>(
    `select p.id, p.email, p.full_name, m.role, m.created_at,
            (select max(s.created_at) from sessions s where s.user_id = p.id) as last_session_at
       from organization_members m
       join profiles p on p.id = m.user_id
      where m.organization_id = ?
      order by m.created_at asc`,
    [organizationId]
  );
}

/** Users across the platform, for /admin/users. */
export function listUsers(input: { search?: string; page?: number; perPage?: number } = {}) {
  const perPage = Math.min(100, Math.max(5, input.perPage ?? 25));
  const page = Math.max(1, input.page ?? 1);
  const search = (input.search ?? "").trim();
  const where = search ? "where lower(p.email) like ? or lower(coalesce(p.full_name,'')) like ?" : "";
  const params: (string | number)[] = search ? [`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`] : [];

  const total = Number(get<{ c: number }>(`select count(*) as c from profiles p ${where}`, params)?.c ?? 0);
  const rows = all<{
    id: string; email: string; full_name: string | null; created_at: string;
    email_verified_at: string | null; is_super_admin: number;
    workspaces: number; last_session_at: string | null; role: string | null;
  }>(
    `select p.id, p.email, p.full_name, p.created_at, p.email_verified_at, p.is_super_admin,
            (select count(*) from organization_members m
              join profiles p2 on p2.id = m.user_id where m.user_id = p.id) as workspaces,
            (select max(s.created_at) from sessions s where s.user_id = p.id) as last_session_at,
            (select m2.role from organization_members m2 where m2.user_id = p.id order by m2.created_at asc limit 1) as role
       from profiles p ${where}
      order by p.created_at desc limit ? offset ?`,
    [...params, perPage, (page - 1) * perPage]
  );
  return { rows, total, page, perPage };
}
