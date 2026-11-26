import type { Metadata } from "next";
import { Workflow } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { TestAutomationForm, RetryButton, AutomationRowActions } from "@/components/automations/automation-forms";
import { AutomationBuilder } from "@/components/automations/automation-builder";
import { listAutomationsWithStats } from "@/lib/actions/automations";
import { executionHistory } from "@/lib/automations";
import { TRIGGER_LABEL } from "@/lib/automation-meta";
import { all } from "@/lib/db";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Automations", robots: { index: false } };

export default async function AutomationsPage() {
  const ctx = await loadAppContext();
  const automations = await listAutomationsWithStats(ctx.orgId);
  const history = executionHistory(ctx.orgId, 25);
  const leads = all<{ id: string; name: string }>(
    "select id, name from leads where organization_id = ? and deleted_at is null order by created_at desc limit 100",
    [ctx.orgId]
  );

  const active = automations.filter((a) => a.is_active).length;
  const totalRuns = automations.reduce((s, a) => s + a.runs, 0);
  const failures = automations.reduce((s, a) => s + a.failures, 0);
  const automationAllowed = ctx.plan.automation_limit > 0;

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      canWriteLeads={ctx.can("lead:write")}
      planName={ctx.plan.name}
      trialDaysLeft={ctx.trialDaysLeft}
      unreadNotifications={ctx.unreadNotifications}
    >
      <PageHeader title="Automations" description="Triggers, conditions and ordered steps — with duplicate-event protection built into the engine." />

      {!automationAllowed ? (
        <div className="mb-4">
          <Alert tone="warning" title="Automations are not in your plan">
            The {ctx.plan.name} plan does not include automations. You can still inspect this page; create one after
            upgrading on the billing page.
          </Alert>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Automations" value={String(automations.length)} hint={`Limit ${ctx.plan.automation_limit || "—"}`} />
        <StatCard label="Active" value={String(active)} tone={active > 0 ? "good" : "default"} />
        <StatCard label="Total runs" value={String(totalRuns)} />
        <StatCard label="Failures" value={String(failures)} tone={failures > 0 ? "warn" : "default"} />
      </div>

      {automationAllowed ? <div className="mb-4"><AutomationBuilder leadCount={leads.length} /></div> : null}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Your automations</CardTitle>
          <CardDescription>Test runs are always dry runs — they never send email or write execution rows.</CardDescription>
        </CardHeader>
        <CardContent>
          {automations.length === 0 ? (
            <EmptyState
              title="No automations yet"
              description="Create one above: pick a trigger such as “New lead submitted”, add conditions, then choose what should happen."
            />
          ) : (
            <div className="space-y-3">
              {automations.map((a) => (
                <div key={a.id} className="rounded-xl border border-[hsl(var(--border))] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        <Workflow className="h-4 w-4 text-brand-600" /> {a.name}
                        <Badge tone={a.is_active ? "success" : "neutral"}>{a.is_active ? "active" : "paused"}</Badge>
                      </p>
                      <p className="mt-1 text-xs text-[hsl(var(--fg-muted))]">
                        {TRIGGER_LABEL[a.trigger_type]} · {a.steps} step{a.steps === 1 ? "" : "s"} · {a.runs} run{a.runs === 1 ? "" : "s"}
                        {a.failures ? ` · ${a.failures} failed` : ""} · max {a.run_limit_per_day}/day
                        {a.last_run_at ? ` · last run ${relativeTime(a.last_run_at)}` : ""}
                      </p>
                      {a.description ? <p className="mt-1 text-sm text-[hsl(var(--fg-muted))]">{a.description}</p> : null}
                    </div>
                    <AutomationRowActions automationId={a.id} active={Boolean(a.is_active)} />
                  </div>
                  <div className="mt-3 border-t border-[hsl(var(--border))] pt-3">
                    <TestAutomationForm automationId={a.id} leads={leads} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Execution history</CardTitle>
          <CardDescription>
            Every run with its step log. Duplicate events for the same record are blocked by an idempotency key.
          </CardDescription>
        </CardHeader>
        {history.length === 0 ? (
          <EmptyState title="No runs recorded" description="Automations write a row here the first time their trigger fires." />
        ) : (
          <Table>
            <THead>
              <TR><TH>Automation</TH><TH>Status</TH><TH>Attempts</TH><TH>When</TH><TH>Detail</TH><TH /></TR>
            </THead>
            <TBody>
              {history.map((h) => (
                <TR key={h.id}>
                  <TD className="font-medium">{h.automation_name}</TD>
                  <TD><Badge tone={h.status === "succeeded" ? "success" : h.status === "failed" ? "danger" : "neutral"}>{h.status}</Badge></TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{h.attempts}</TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{relativeTime(h.created_at)}</TD>
                  <TD className="max-w-[320px]">
                    {h.error ? (
                      <span className="text-xs text-red-600">{h.error}</span>
                    ) : (
                      <span className="text-xs text-[hsl(var(--fg-muted))]">
                        {h.logParsed.map((l) => `${l.action}: ${l.status}`).join(" → ") || "no steps logged"}
                      </span>
                    )}
                  </TD>
                  <TD>{h.status === "failed" ? <RetryButton executionId={h.id} /> : null}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </AppShell>
  );
}
