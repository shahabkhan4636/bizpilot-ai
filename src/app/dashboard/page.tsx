import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, Clock, Sparkles, Upload } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard, BarChart } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/table";
import { all, get } from "@/lib/db";
import { formatMoney, relativeTime, percent } from "@/lib/utils";
import { LEAD_STATUS_LABEL, type LeadStatus } from "@/lib/csv";
import { limitLabel, usageLabel } from "@/lib/limits";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false } };

type StatusRow = { status: LeadStatus; count: number; value: number };

export default async function DashboardPage() {
  const ctx = await loadAppContext();
  const orgId = ctx.orgId;

  const totals = get<{ total: number; open: number; won: number; lost: number; pipeline: number; won_value: number }>(
    `select count(*) as total,
            sum(case when status not in ('won','lost') then 1 else 0 end) as open,
            sum(case when status = 'won' then 1 else 0 end) as won,
            sum(case when status = 'lost' then 1 else 0 end) as lost,
            coalesce(sum(case when status not in ('won','lost') then value_cents else 0 end),0) as pipeline,
            coalesce(sum(case when status = 'won' then value_cents else 0 end),0) as won_value
       from leads where organization_id = ? and deleted_at is null`,
    [orgId]
  ) ?? { total: 0, open: 0, won: 0, lost: 0, pipeline: 0, won_value: 0 };

  const newThisWeek = get<{ c: number }>(
    "select count(*) as c from leads where organization_id = ? and deleted_at is null and created_at >= ?",
    [orgId, new Date(Date.now() - 7 * 864e5).toISOString()]
  )?.c ?? 0;

  const byStatus = all<StatusRow>(
    `select status, count(*) as count, coalesce(sum(value_cents),0) as value
       from leads where organization_id = ? and deleted_at is null group by status`,
    [orgId]
  );
  const statusMap = new Map(byStatus.map((r) => [r.status, r]));

  const bySource = all<{ source: string; count: number }>(
    `select source, count(*) as count from leads
      where organization_id = ? and deleted_at is null group by source order by count desc limit 6`,
    [orgId]
  );

  const followUps = all<{ id: string; name: string; next_follow_up_at: string; status: string }>(
    `select id, name, next_follow_up_at, status from leads
      where organization_id = ? and deleted_at is null and next_follow_up_at is not null
        and next_follow_up_at <= ? order by next_follow_up_at asc limit 5`,
    [orgId, new Date(Date.now() + 2 * 864e5).toISOString()]
  );

  const recent = all<{ id: string; action: string; summary: string | null; created_at: string }>(
    "select id, action, summary, created_at from activities where organization_id = ? order by created_at desc limit 8",
    [orgId]
  );

  const aiScored = get<{ c: number; avg: number | null }>(
    "select count(*) as c, avg(ai_score) as avg from leads where organization_id = ? and deleted_at is null and ai_score is not null",
    [orgId]
  ) ?? { c: 0, avg: null };

  const proposals = get<{ total: number; accepted: number; sent: number; value: number }>(
    `select count(*) as total,
            sum(case when status='accepted' then 1 else 0 end) as accepted,
            sum(case when status='sent' then 1 else 0 end) as sent,
            coalesce(sum(case when status='accepted' then total_cents else 0 end),0) as value
       from proposals where organization_id = ?`,
    [orgId]
  ) ?? { total: 0, accepted: 0, sent: 0, value: 0 };

  const conversion = percent(totals.won, totals.total);
  const hasLeads = totals.total > 0;

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
        title={`Good to see you, ${ctx.displayName.split(" ")[0]}`}
        description="Every number below is calculated from records in your workspace."
        actions={
          <>
            <Link href="/leads?new=1"><Button size="sm">Add lead</Button></Link>
            <Link href="/leads/import"><Button size="sm" variant="outline"><Upload className="h-4 w-4" /> Import CSV</Button></Link>
          </>
        }
      />

      {ctx.trialDaysLeft !== null && ctx.trialDaysLeft <= 3 ? (
        <div className="mb-4">
          <Alert tone="warning" title={`Trial ends in ${ctx.trialDaysLeft} day${ctx.trialDaysLeft === 1 ? "" : "s"}`}>
            Choose a plan on the <Link href="/billing" className="underline">billing page</Link> to keep automations and AI generations running.
          </Alert>
        </div>
      ) : null}

      {!hasLeads ? (
        <Card className="mb-6">
          <EmptyState
            title="Your workspace is empty — let's fix that"
            description="Add your first lead manually, import a CSV, or connect the public capture form. Metrics appear here as soon as real records exist."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/leads?new=1"><Button size="sm">Add first lead</Button></Link>
                <Link href="/leads/import"><Button size="sm" variant="outline">Import CSV</Button></Link>
                <Link href="/help#capture"><Button size="sm" variant="ghost">Capture form setup</Button></Link>
              </div>
            }
          />
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Total leads" value={String(totals.total)} hint={`${newThisWeek} added in the last 7 days`} />
        <StatCard label="Open pipeline" value={formatMoney(totals.pipeline)} hint={`${totals.open} open lead${totals.open === 1 ? "" : "s"}`} />
        <StatCard label="Won revenue" value={formatMoney(totals.won_value)} hint={`${totals.won} won · ${totals.lost} lost`} tone="good" />
        <StatCard label="Conversion rate" value={`${conversion}%`} hint="Won ÷ all leads" tone={conversion >= 25 ? "good" : "default"} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Pipeline by status</CardTitle>
            <CardDescription>Lead counts across the seven pipeline stages.</CardDescription>
          </CardHeader>
          <CardContent>
            {hasLeads ? (
              <>
                <BarChart data={(["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"] as LeadStatus[]).map((s) => ({
                  label: LEAD_STATUS_LABEL[s].split(" ")[0],
                  value: statusMap.get(s)?.count ?? 0,
                }))} />
                <div className="mt-4 space-y-1.5">
                  {(["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"] as LeadStatus[])
                    .filter((s) => (statusMap.get(s)?.count ?? 0) > 0)
                    .map((s) => (
                      <div key={s} className="flex items-center justify-between text-sm">
                        <span className="text-[hsl(var(--fg-muted))]">{LEAD_STATUS_LABEL[s]}</span>
                        <span className="font-medium">
                          {statusMap.get(s)?.count} · {formatMoney(statusMap.get(s)?.value ?? 0)}
                        </span>
                      </div>
                    ))}
                </div>
              </>
            ) : (
              <p className="py-8 text-center text-sm text-[hsl(var(--fg-muted))]">No leads yet — the chart fills in as records arrive.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Follow-ups due</CardTitle>
            <CardDescription>Reminders within the next 48 hours.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {followUps.length === 0 ? (
              <p className="py-6 text-center text-sm text-[hsl(var(--fg-muted))]">
                Nothing scheduled. Set a follow-up date on any lead to see it here.
              </p>
            ) : (
              followUps.map((f) => (
                <Link key={f.id} href={`/leads/${f.id}`} className="flex items-start gap-2 rounded-lg border border-[hsl(var(--border))] p-2.5 hover:bg-[hsl(var(--muted))]">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{f.name}</p>
                    <p className="text-xs text-[hsl(var(--fg-muted))]">{relativeTime(f.next_follow_up_at)}</p>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Lead sources</CardTitle>
            <CardDescription>Where your records came from.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {bySource.length === 0 ? (
              <p className="py-6 text-center text-sm text-[hsl(var(--fg-muted))]">Sources appear once leads exist.</p>
            ) : (
              bySource.map((s) => (
                <div key={s.source} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-[hsl(var(--fg-muted))]">{s.source.replace(/_/g, " ")}</span>
                  <Badge>{s.count}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>AI &amp; proposals</CardTitle>
            <CardDescription>Scoring and acceptance, from real rows.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Leads scored" value={`${aiScored.c} of ${totals.total}`} />
            <Row label="Average score" value={aiScored.avg ? String(Math.round(aiScored.avg)) : "—"} />
            <Row label="AI generations this month" value={usageLabel(ctx.usage.aiThisMonth, ctx.plan.ai_generation_limit)} />
            <Row label="Proposals sent" value={String(proposals.sent ?? 0)} />
            <Row label="Proposals accepted" value={String(proposals.accepted ?? 0)} />
            <Row label="Accepted value" value={formatMoney(proposals.value ?? 0)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Append-only log for this workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-[hsl(var(--fg-muted))]">Actions you take will be listed here.</p>
            ) : (
              recent.map((a) => (
                <div key={a.id} className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <div className="min-w-0">
                    <p className="truncate text-sm">{a.summary ?? a.action}</p>
                    <p className="text-xs text-[hsl(var(--fg-muted))]">{relativeTime(a.created_at)}</p>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {!ctx.subscribed ? (
        <div className="mt-4">
          <Alert tone="info" title="You are on the free trial">
            Paid features unlock after a verified Stripe subscription. Nothing is granted from a success page — only a
            signed webhook marks a subscription active. <Link href="/billing" className="underline">View plans</Link>
          </Alert>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/ai-assistant"><Button variant="outline" size="sm"><Sparkles className="h-4 w-4" /> Draft an outreach email</Button></Link>
        <Link href="/analytics"><Button variant="outline" size="sm">Open analytics <ArrowRight className="h-4 w-4" /></Button></Link>
        <Link href="/automations"><Button variant="outline" size="sm">Set up an automation</Button></Link>
      </div>

      {ctx.usage.leads >= ctx.plan.lead_limit ? (
        <div className="mt-4">
          <Alert tone="danger" title="Lead limit reached">
            <span className="inline-flex items-center gap-1"><AlertTriangle className="h-4 w-4" /> You have used {ctx.usage.leads} of {limitLabel(ctx.plan.lead_limit)} leads. Upgrade to keep capturing.</span>
          </Alert>
        </div>
      ) : null}
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[hsl(var(--fg-muted))]">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
