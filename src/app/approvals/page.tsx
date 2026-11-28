import type { Metadata } from "next";
import Link from "next/link";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/table";
import { ApproveMessageForm, RejectMessageButton } from "@/components/approvals/approval-forms";
import { all } from "@/lib/db";
import { isEmailConfigured } from "@/lib/email";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Approvals", robots: { index: false } };

export default async function ApprovalsPage() {
  const ctx = await loadAppContext();

  const messages = all<{
    id: string; subject: string | null; body: string; status: string; created_at: string;
    lead_id: string | null; lead_name: string | null; lead_email: string | null;
    customer_id: string | null; customer_name: string | null; customer_email: string | null;
  }>(
    `select m.id, m.subject, m.body, m.status, m.created_at,
            l.id as lead_id, l.name as lead_name, l.email as lead_email,
            c.id as customer_id, c.name as customer_name, c.email as customer_email
       from messages m
       left join leads l on l.id = m.lead_id
       left join customers c on c.id = m.customer_id
      where m.organization_id = ? and m.status = 'pending_approval'
      order by m.created_at desc limit 50`,
    [ctx.orgId]
  );

  const recent = all<{ id: string; status: string; created_at: string; subject: string | null }>(
    `select id, status, created_at, subject from messages
      where organization_id = ? and status <> 'pending_approval'
      order by created_at desc limit 10`,
    [ctx.orgId]
  );

  // Messages a human approved that the provider never delivered, so the state is
  // visible instead of being buried in a transient banner.
  const undelivered = all<{ id: string; subject: string | null; status: string }>(
    `select id, subject, status from messages
      where organization_id = ? and status in ('approved_unsent','failed')
      order by created_at desc limit 10`,
    [ctx.orgId]
  );

  const emailReady = isEmailConfigured();

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
        title="Approvals"
        description="Everything the automations and the AI assistant want to send waits here. Nothing leaves the workspace without a human tick."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Waiting for approval" value={String(messages.length)} tone={messages.length ? "warn" : "default"} />
        <StatCard label="Email delivery" value={emailReady ? "configured" : "not configured"} tone={emailReady ? "default" : "warn"} />
        <StatCard label="Decided recently" value={String(recent.length)} />
      </div>

      {undelivered.length > 0 ? (
        <div className="mb-4">
          <Alert tone="warning" title={`${undelivered.length} approved message${undelivered.length === 1 ? "" : "s"} not delivered`}>
            {emailReady
              ? "These were approved but the provider did not accept them. Open the record to copy the text or retry after fixing the provider."
              : "Approval is recorded, but nothing was sent because RESEND_API_KEY is not configured. The text is kept so it can be copied out."}
            <ul className="mt-2 list-disc pl-5 text-xs">
              {undelivered.map((m) => <li key={m.id}>{m.subject ?? "(no subject)"} — {m.status.replace("_", " ")}</li>)}
            </ul>
          </Alert>
        </div>
      ) : null}

      {!emailReady ? (
        <div className="mb-4">
          <Alert tone="warning" title="Email delivery is not configured">
            Approving a message saves it as <strong>approved, unsent</strong> because <code>RESEND_API_KEY</code> is missing.
            Nothing is ever reported as delivered when it was not.
          </Alert>
        </div>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Waiting for approval</CardTitle>
          <CardDescription>Queued by an automation or the AI assistant. Read it, then approve or reject.</CardDescription>
        </CardHeader>
        <CardContent>
          {messages.length === 0 ? (
            <EmptyState
              title="Nothing waiting"
              description="When an automation queues an email, it appears here for review before it can be sent."
            />
          ) : (
            <div className="space-y-3">
              {messages.map((m) => {
                const recipientEmail = m.lead_email ?? m.customer_email;
                const recipientName = m.lead_name ?? m.customer_name;
                const href = m.lead_id ? `/leads/${m.lead_id}` : m.customer_id ? `/customers/${m.customer_id}` : null;
                return (
                  <div key={m.id} className="rounded-xl border border-[hsl(var(--border))] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium">{m.subject ?? "(no subject)"}</p>
                        <p className="text-xs text-[hsl(var(--fg-muted))]">
                          To {recipientName ?? "unknown"} {recipientEmail ? `<${recipientEmail}>` : "(no email address)"} ·{" "}
                          {relativeTime(m.created_at)}
                          {href ? (
                            <>
                              {" · "}
                              <Link className="underline" href={href}>View record</Link>
                            </>
                          ) : null}
                        </p>
                      </div>
                      <Badge tone="warning">pending approval</Badge>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg bg-[hsl(var(--muted))] p-2.5 text-sm">{m.body}</p>
                    <div className="mt-3 flex flex-wrap items-start gap-3">
                      <ApproveMessageForm messageId={m.id} />
                      <RejectMessageButton messageId={m.id} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently decided</CardTitle>
          <CardDescription>The last ten messages that left this queue.</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <EmptyState title="No decisions yet" description="Approved and rejected messages are listed here with their final state." />
          ) : (
            <ul className="space-y-2 text-sm">
              {recent.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--border))] pb-2 last:border-0">
                  <span className="min-w-0 truncate">{m.subject ?? "(no subject)"}</span>
                  <span className="flex items-center gap-2 text-xs text-[hsl(var(--fg-muted))]">
                    <Badge tone={m.status === "sent" ? "success" : m.status === "failed" ? "danger" : m.status === "rejected" ? "neutral" : "warning"}>
                      {m.status.replace("_", " ")}
                    </Badge>
                    {relativeTime(m.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
