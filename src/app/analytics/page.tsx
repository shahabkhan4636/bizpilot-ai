import type { Metadata } from "next";
import Link from "next/link";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard, BarChart } from "@/components/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/table";
import { all, get } from "@/lib/db";
import { formatMoney, percent } from "@/lib/utils";
import { LEAD_STATUS_LABEL, type LeadStatus } from "@/lib/csv";

export const metadata: Metadata = { title: "Analytics", robots: { index: false } };

export default async function AnalyticsPage() {
  const ctx = await loadAppContext();
  const orgId = ctx.orgId;

  const totals = get<{ total: number; won: number; lost: number; pipeline: number; won_value: number; avg_value: number }>(
    `select count(*) as total,
            sum(case when status='won' then 1 else 0 end) as won,
            sum(case when status='lost' then 1 else 0 end) as lost,
            coalesce(sum(case when status not in ('won','lost') then value_cents else 0 end),0) as pipeline,
            coalesce(sum(case when status='won' then value_cents else 0 end),0) as won_value,
            coalesce(avg(nullif(value_cents,0)),0) as avg_value
       from leads where organization_id = ? and deleted_at is null`,
    [orgId]
  ) ?? { total: 0, won: 0, lost: 0, pipeline: 0, won_value: 0, avg_value: 0 };

  const funnel = all<{ status: LeadStatus; count: number; value: number }>(
    "select status, count(*) as count, coalesce(sum(value_cents),0) as value from leads where organization_id = ? and deleted_at is null group by status",
    [orgId]
  );
  const funnelMap = new Map(funnel.map((f) => [f.status, f]));

  const sources = all<{ source: string; count: number; won: number; value: number }>(
    `select source, count(*) as count,
            sum(case when status='won' then 1 else 0 end) as won,
            coalesce(sum(value_cents),0) as value
       from leads where organization_id = ? and deleted_at is null
      group by source order by count desc`,
    [orgId]
  );

  const owners = all<{ owner: string; count: number; won: number; value: number }>(
    `select coalesce(p.full_name, p.email, 'Unassigned') as owner, count(*) as count,
            sum(case when l.status='won' then 1 else 0 end) as won,
            coalesce(sum(l.value_cents),0) as value
       from leads l left join profiles p on p.id = l.assigned_to
      where l.organization_id = ? and l.deleted_at is null
      group by owner order by count desc`,
    [orgId]
  );

  const proposals = get<{ total: number; sent: number; accepted: number; rejected: number; accepted_value: number }>(
    `select count(*) as total,
            sum(case when status='sent' then 1 else 0 end) as sent,
            sum(case when status='accepted' then 1 else 0 end) as accepted,
            sum(case when status='rejected' then 1 else 0 end) as rejected,
            coalesce(sum(case when status='accepted' then total_cents else 0 end),0) as accepted_value
       from proposals where organization_id = ?`,
    [orgId]
  ) ?? { total: 0, sent: 0, accepted: 0, rejected: 0, accepted_value: 0 };

  // Monthly buckets for the last 6 months, computed from created_at.
  const monthly: { label: string; value: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCMonth(start.getUTCMonth() - i);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    const row = get<{ c: number }>(
      "select count(*) as c from leads where organization_id = ? and deleted_at is null and created_at >= ? and created_at < ?",
      [orgId, start.toISOString(), end.toISOString()]
    );
    monthly.push({ label: start.toLocaleString("en-US", { month: "short" }), value: row?.c ?? 0 });
  }

  const leadToProposal = percent(proposals.total, totals.total);
  const proposalWin = percent(proposals.accepted ?? 0, proposals.total || 1);
  const hasData = totals.total > 0;

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
        title="Analytics"
        description="Every figure is a live aggregate query over your workspace records."
        actions={<a href="/api/leads/export" className={buttonVariants({ variant: "outline", size: "sm" })}>Export leads CSV</a>}
      />

      {!hasData ? (
        <Card className="mb-4">
          <EmptyState
            title="No data to analyse yet"
            description="Add or import leads and the funnel, source mix and monthly trend fill in automatically."
            action={<Link href="/leads/import"><Button size="sm">Import leads</Button></Link>}
          />
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Leads" value={String(totals.total)} />
        <StatCard label="Win rate" value={`${percent(totals.won, totals.total)}%`} hint={`${totals.won} won / ${totals.lost} lost`} tone="good" />
        <StatCard label="Average deal" value={formatMoney(Math.round(totals.avg_value))} />
        <StatCard label="Won revenue" value={formatMoney(totals.won_value)} tone="good" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>New leads per month</CardTitle>
            <CardDescription>Last six calendar months, based on creation date.</CardDescription>
          </CardHeader>
          <CardContent><BarChart data={monthly} height={170} /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Conversion funnel</CardTitle>
            <CardDescription>Lead → proposal → acceptance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Leads" value={String(totals.total)} />
            <Row label="Proposals created" value={`${proposals.total} (${leadToProposal}% of leads)`} />
            <Row label="Proposals sent" value={String(proposals.sent ?? 0)} />
            <Row label="Accepted" value={`${proposals.accepted ?? 0} (${proposalWin}% of proposals)`} />
            <Row label="Declined" value={String(proposals.rejected ?? 0)} />
            <Row label="Accepted value" value={formatMoney(proposals.accepted_value ?? 0)} />
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Pipeline by stage</CardTitle>
            <CardDescription>Counts and value per status.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"] as LeadStatus[]).map((s) => (
              <div key={s} className="flex items-center justify-between gap-2">
                <span className="text-[hsl(var(--fg-muted))]">{LEAD_STATUS_LABEL[s]}</span>
                <span className="tabular-nums">{funnelMap.get(s)?.count ?? 0} · {formatMoney(funnelMap.get(s)?.value ?? 0)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Source performance</CardTitle>
            <CardDescription>Which channels actually close.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {sources.length === 0 ? (
              <p className="text-[hsl(var(--fg-muted))]">No sources recorded.</p>
            ) : (
              sources.map((s) => (
                <div key={s.source} className="flex items-center justify-between gap-2">
                  <span className="capitalize text-[hsl(var(--fg-muted))]">{s.source.replace(/_/g, " ")}</span>
                  <span className="tabular-nums">{s.count} leads · {s.won} won · {formatMoney(s.value)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Team performance</CardTitle>
          <CardDescription>Leads owned and won per member.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {owners.length === 0 ? (
            <p className="text-[hsl(var(--fg-muted))]">No assigned leads yet.</p>
          ) : (
            owners.map((o) => (
              <div key={o.owner} className="flex items-center justify-between gap-2">
                <span className="text-[hsl(var(--fg-muted))]">{o.owner}</span>
                <span className="tabular-nums">
                  {o.count} assigned · {o.won} won · {formatMoney(o.value)} · {percent(o.won, o.count)}% win rate
                </span>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[hsl(var(--fg-muted))]">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}
