import type { Metadata } from "next";
import Link from "next/link";

import { ShieldCheck } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { requireSuperAdmin } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PlanEditor, OrgActions } from "@/components/admin/admin-forms";
import { all, get } from "@/lib/db";
import { isPlatformOwnerWorkspace } from "@/lib/plans";
import { isStripeConfigured } from "@/lib/stripe";
import { isAiConfigured } from "@/lib/ai";
import { isEmailConfigured } from "@/lib/email";
import { isDropboxConfigured } from "@/lib/storage";
import { formatDate, relativeTime, formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

export default async function AdminPage() {
  // Server-side gate first, before any data is read. A non-owner gets a 404 (see
  // requireSuperAdmin) — hiding the sidebar link was never the gate.
  await requireSuperAdmin();
  const ctx = await loadAppContext();

  const plans = all<{
    code: string; name: string; price_monthly_cents: number; price_annual_cents: number; lead_limit: number;
    member_limit: number; ai_generation_limit: number; automation_limit: number; document_limit: number; features: string;
  }>("select * from plans order by sort_order asc");

  const orgs = all<{
    id: string; name: string; slug: string; created_at: string; suspended_at: string | null;
    members: number; leads: number; plan_code: string | null; status: string | null;
  }>(
    `select o.id, o.name, o.slug, o.created_at, o.suspended_at,
            (select count(*) from organization_members m where m.organization_id = o.id) as members,
            (select count(*) from leads l where l.organization_id = o.id and l.deleted_at is null) as leads,
            (select plan_code from subscriptions s where s.organization_id = o.id) as plan_code,
            (select status from subscriptions s where s.organization_id = o.id) as status
       from organizations o order by o.created_at desc limit 100`
  );

  // Which workspaces are the platform owner's own? Shown as a badge so a workspace
  // that is never billed and never limited is obviously intentional, not a bug.
  const ownerWorkspaceIds = new Set(orgs.filter((org) => isPlatformOwnerWorkspace(org.id)).map((org) => org.id));

  const auditLogs = all<{ id: string; action: string; actor_id: string | null; target_type: string | null; created_at: string }>(
    "select id, action, actor_id, target_type, created_at from audit_logs order by created_at desc limit 30"
  );

  const webhooks = all<{ id: string; event_type: string; processed_at: string | null; error: string | null; created_at: string }>(
    "select id, event_type, processed_at, error, created_at from webhook_events order by created_at desc limit 15"
  );

  const counts = {
    users: get<{ c: number }>("select count(*) as c from profiles")?.c ?? 0,
    orgs: get<{ c: number }>("select count(*) as c from organizations")?.c ?? 0,
    leads: get<{ c: number }>("select count(*) as c from leads where deleted_at is null")?.c ?? 0,
    proposals: get<{ c: number }>("select count(*) as c from proposals")?.c ?? 0,
  };

  const integrations = [
    { name: "Stripe", ready: isStripeConfigured(), note: "Checkout, portal and webhooks" },
    { name: "AI provider", ready: isAiConfigured(), note: "LLM generation via OpenAI-compatible API" },
    { name: "Resend email", ready: isEmailConfigured(), note: "Transactional email delivery" },
    { name: "Dropbox", ready: isDropboxConfigured(), note: "File storage (records stay in the database)" },
  ];

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
      <PageHeader
        title="Admin panel"
        description="Platform-wide view. Access is verified on the server for every request, not just hidden in the UI."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/workspaces"><Button size="sm" variant="outline">Workspaces</Button></Link>
            <Link href="/admin/users"><Button size="sm" variant="outline">Users</Button></Link>
            <Link href="/admin/payments"><Button size="sm" variant="outline">Payments</Button></Link>
            <Link href="/admin/platform-payments"><Button size="sm" variant="outline">Payout settings</Button></Link>
            <Link href="/admin/email"><Button size="sm" variant="outline">Email outbox</Button></Link>
            <Link href="/help"><Button size="sm" variant="outline">Operations guide</Button></Link>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Users" value={String(counts.users)} />
        <StatCard label="Workspaces" value={String(counts.orgs)} />
        <StatCard label="Leads" value={String(counts.leads)} />
        <StatCard label="Proposals" value={String(counts.proposals)} />
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Integration status</CardTitle>
          <CardDescription>Reported from the environment — nothing is shown as connected without credentials.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {integrations.map((i) => (
            <div key={i.name} className="rounded-lg border border-[hsl(var(--border))] p-3">
              <p className="flex items-center justify-between text-sm font-medium">
                {i.name}
                <Badge tone={i.ready ? "success" : "warning"}>{i.ready ? "configured" : "not configured"}</Badge>
              </p>
              <p className="mt-1 text-xs text-[hsl(var(--fg-muted))]">{i.note}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Plans &amp; pricing</CardTitle>
          <CardDescription>Editable here; the marketing pricing page reads the same rows.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((p) => <PlanEditor key={p.code} plan={p} />)}
        </CardContent>
      </Card>

      <Card className="mb-4 overflow-hidden">
        <CardHeader>
          <CardTitle>Workspaces</CardTitle>
          <CardDescription>Suspend a workspace to block all of its users immediately.</CardDescription>
        </CardHeader>
        <Table>
          <THead><TR><TH>Workspace</TH><TH>Plan</TH><TH>Members</TH><TH>Leads</TH><TH>Created</TH><TH>Status</TH><TH>Actions</TH></TR></THead>
          <TBody>
            {orgs.map((o) => (
              <TR key={o.id}>
                <TD className="font-medium">
                  <span className="flex flex-wrap items-center gap-1">
                    {o.name}
                    {ownerWorkspaceIds.has(o.id) ? <Badge tone="brand">Platform owner</Badge> : null}
                  </span>
                  <p className="text-xs text-[hsl(var(--fg-muted))]">{o.slug}</p>
                </TD>
                <TD className="capitalize">
                  {ownerWorkspaceIds.has(o.id) ? "unlimited" : (o.plan_code ?? "—")}
                  <p className="text-xs text-[hsl(var(--fg-muted))]">{ownerWorkspaceIds.has(o.id) ? "never billed" : (o.status ?? "no sub")}</p>
                </TD>
                <TD>{o.members}</TD>
                <TD>{o.leads}</TD>
                <TD className="text-[hsl(var(--fg-muted))]">{formatDate(o.created_at)}</TD>
                <TD>{o.suspended_at ? <Badge tone="danger">suspended</Badge> : <Badge tone="success">active</Badge>}</TD>
                <TD><OrgActions orgId={o.id} suspended={Boolean(o.suspended_at)} planCode={o.plan_code ?? "starter"} plans={plans} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
            <CardDescription>Most recent privileged actions.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {auditLogs.length === 0 ? <p className="text-[hsl(var(--fg-muted))]">No entries yet.</p> : auditLogs.map((l) => (
              <div key={l.id} className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{l.action}</span>
                <span className="text-xs text-[hsl(var(--fg-muted))]">{l.target_type ?? "—"} · {relativeTime(l.created_at)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Webhook deliveries</CardTitle>
            <CardDescription>Signature-verified Stripe events.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {webhooks.length === 0 ? <p className="text-[hsl(var(--fg-muted))]">No webhook events recorded.</p> : webhooks.map((w) => (
              <div key={w.id} className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{w.event_type}</span>
                <span className="text-xs text-[hsl(var(--fg-muted))]">
                  {w.processed_at ? "processed" : "pending"} · {relativeTime(w.created_at)}
                  {w.error ? ` · ${w.error.slice(0, 40)}` : ""}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4">
        <Alert tone="info" title="Security model in this deployment">
          <span className="inline-flex items-center gap-1"><ShieldCheck className="h-4 w-4" /></span> Role checks run server-side on
          every page and server action; tenant scoping is applied to every query; the Postgres schema enables row level
          security with <code>auth_user_org_ids()</code>. Plan limits are enforced in the data layer. Secrets are read from
          environment variables only and are never rendered. Today&apos;s Starter price is{" "}
          {formatMoney(plans.find((p) => p.code === "starter")?.price_monthly_cents ?? 0)}.
        </Alert>
      </div>
    </AppShell>
  );
}
