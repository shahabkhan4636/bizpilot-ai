import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, Crown, Users } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { requireSuperAdmin } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ImpersonateButton, SuspendWorkspaceForm, WorkspacePlanForm } from "@/components/admin/workspace-forms";
import { FoundingMemberControls } from "@/components/admin/platform-payment-forms";
import { getWorkspace, listWorkspaceMembers } from "@/lib/admin/workspaces";
import { foundingForOrg, listClaimsForOrg } from "@/lib/platform-payments-server";
import { isPlatformOwnerWorkspace } from "@/lib/plans";
import { all } from "@/lib/db";
import { formatDate, relativeTime } from "@/lib/utils";

/**
 * /admin/workspaces/[id] — everything about one customer workspace.
 *
 * Every destructive control on this page is individually confirmed and individually
 * audited; the page itself is a plain server render, so nothing here can fire by
 * accident while scrolling.
 */

export const metadata: Metadata = { title: "Workspace", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminWorkspaceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ impersonationError?: string; done?: string }>;
}) {
  await requireSuperAdmin();
  const ctx = await loadAppContext();
  const { id } = await params;
  const { impersonationError, done } = await searchParams;

  const workspace = getWorkspace(id);
  if (!workspace) notFound();

  const members = listWorkspaceMembers(id);
  const plans = all<{ code: string; name: string }>("select code, name from plans order by sort_order asc");
  const founding = foundingForOrg(id);
  const claims = listClaimsForOrg(id, 10);
  const isOwnerWorkspace = isPlatformOwnerWorkspace(id);

  const auditTrail = all<{ id: string; action: string; actor_id: string | null; metadata: string; created_at: string }>(
    "select id, action, actor_id, metadata, created_at from audit_logs where organization_id = ? order by created_at desc limit 15",
    [id]
  );

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      canWriteLeads={ctx.can("lead:write")}
      planName={ctx.plan.name}
      impersonation={ctx.impersonation}
      trialDaysLeft={ctx.trialDaysLeft}
      unreadNotifications={ctx.unreadNotifications}
    >
      <Link href="/admin/workspaces" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Workspaces
      </Link>

      <PageHeader
        title={workspace.name}
        description={`${workspace.slug} · created ${formatDate(workspace.created_at)}${workspace.owner_email ? ` · owner ${workspace.owner_email}` : ""}`}
        actions={
          <div className="flex flex-wrap gap-1">
            {isOwnerWorkspace ? <Badge tone="brand">Platform owner</Badge> : null}
            {founding ? <Badge tone="info">Founding Member</Badge> : null}
            {workspace.suspended_at ? <Badge tone="danger">suspended</Badge> : <Badge tone="success">active</Badge>}
          </div>
        }
      />

      {done === "suspended" ? (
        <div className="mb-4">
          <Alert tone="success" title="Workspace suspended">
            Every write in this workspace is now blocked, the reason is on the record, and the owner has been notified
            and emailed.
          </Alert>
        </div>
      ) : null}
      {done === "restored" ? (
        <div className="mb-4">
          <Alert tone="success" title="Workspace restored">
            Access is back, the restore reason is in the audit log, and the owner has been told.
          </Alert>
        </div>
      ) : null}
      {done === "plan" ? (
        <div className="mb-4">
          <Alert tone="info" title="Plan updated">
            The new limits apply immediately. No charge was made — this is a support action, not a sale.
          </Alert>
        </div>
      ) : null}
      {impersonationError ? (
        <div className="mb-4">
          <Alert tone="danger" title="Impersonation not started">{impersonationError}</Alert>
        </div>
      ) : null}
      {workspace.suspended_at ? (
        <div className="mb-4">
          <Alert tone="warning" title="This workspace is suspended">
            {workspace.suspension_reason ?? "No reason recorded."}
            {workspace.suspended_by_email ? ` — by ${workspace.suspended_by_email} on ${formatDate(workspace.suspended_at)}` : ""}
          </Alert>
        </div>
      ) : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Plan"
          value={isOwnerWorkspace ? "unlimited" : (workspace.plan_name ?? workspace.plan_code ?? "—")}
          hint={isOwnerWorkspace ? "never billed" : (workspace.status ?? "no subscription")}
        />
        <StatCard label="Members" value={String(workspace.members)} hint={founding ? `${founding.member_limit} seats (Founding)` : undefined} />
        <StatCard label="Leads" value={`${workspace.leads}${workspace.leads_limit ? ` / ${workspace.leads_limit}` : ""}`} hint="this workspace" />
        <StatCard label="AI this month" value={String(workspace.ai_used ?? 0)} hint={workspace.ai_limit ? `limit ${workspace.ai_limit}` : "no limit"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Members</CardTitle>
            <CardDescription>
              &ldquo;Impersonate&rdquo; opens the workspace as that person, read-only until you confirm write mode.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Role</TH>
                  <TH>Last signed in</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {members.map((member) => (
                  <TR key={member.id}>
                    <TD>
                      {member.full_name ?? "—"}
                      <p className="text-xs text-[hsl(var(--fg-muted))]">{member.email}</p>
                    </TD>
                    <TD className="capitalize">{member.role}</TD>
                    <TD className="text-xs">{member.last_session_at ? relativeTime(member.last_session_at) : "never"}</TD>
                    <TD>
                      {isOwnerWorkspace ? (
                        <span className="text-xs text-[hsl(var(--fg-muted))]">owner workspace</span>
                      ) : (
                        <ImpersonateButton userId={member.id} organizationId={workspace.id} label={member.email} />
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Plan &amp; billing</CardTitle>
            <CardDescription>Assigning a plan here never charges the customer.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <WorkspacePlanForm
              organizationId={workspace.id}
              planCode={workspace.plan_code ?? "starter"}
              plans={plans}
            />
            <div className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium"><Crown className="h-4 w-4" /> Founding Member</p>
              <FoundingMemberControls organizationId={workspace.id} isMember={Boolean(founding)} />
            </div>
            {claims.length > 0 ? (
              <div>
                <p className="mb-1 text-sm font-medium">Platform payments</p>
                <ul className="space-y-1 text-xs text-[hsl(var(--fg-muted))]">
                  {claims.map((claim) => (
                    <li key={claim.id}>
                      {formatDate(claim.submitted_at)} · Rs {Math.round(claim.amount_cents / 100).toLocaleString()} ·{" "}
                      {claim.plan_code} · <strong>{claim.status}</strong>
                      {claim.self_approved === 1 ? " · self-approved" : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Danger zone</CardTitle>
            <CardDescription>Both actions require a reason, and both email the workspace owner.</CardDescription>
          </CardHeader>
          <CardContent>
            {isOwnerWorkspace ? (
              <Alert tone="info" title="The platform owner's workspace cannot be suspended">
                Locking yourself out through the support tool is an outage, not a mistake — so the rule refuses it.
              </Alert>
            ) : (
              <SuspendWorkspaceForm organizationId={workspace.id} suspended={Boolean(workspace.suspended_at)} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent audit trail</CardTitle>
            <CardDescription>Newest first. Impersonated writes are flagged here.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {auditTrail.length === 0 ? (
              <p className="text-[hsl(var(--fg-muted))]">No entries yet.</p>
            ) : (
              auditTrail.map((entry) => (
                <div key={entry.id} className="flex items-start justify-between gap-2">
                  <span className="font-mono">{entry.action}</span>
                  <span className="text-[hsl(var(--fg-muted))]">
                    {entry.metadata.includes("impersonated_write") ? "⚑ impersonated · " : ""}
                    {relativeTime(entry.created_at)}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
