import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Building2, Mail, Phone, Trash2 } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NoteForm, ScoreLeadButton, UpdateLeadForm, AssignForm } from "@/components/leads/lead-forms";
import { listMembers, deleteLeadAction } from "@/lib/actions/leads";
import { convertLeadToCustomerAction } from "@/lib/actions/customers";
import { all, get } from "@/lib/db";
import { formatMoney, formatDate, relativeTime } from "@/lib/utils";
import { LEAD_STATUS_LABEL, type LeadStatus } from "@/lib/csv";

export const metadata: Metadata = { title: "Lead detail", robots: { index: false } };

type Lead = {
  id: string; name: string; email: string | null; phone: string | null; company: string | null;
  status: LeadStatus; source: string; value_cents: number; notes: string | null;
  ai_score: number | null; ai_score_reason: string | null; ai_next_action: string | null; ai_scored_at: string | null;
  next_follow_up_at: string | null; created_at: string; assigned_to: string | null; owner_name: string | null;
  customer_id: string | null;
};

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadAppContext();
  const orgId = ctx.orgId;

  const lead = get<Lead>(
    `select l.*, p.full_name as owner_name from leads l left join profiles p on p.id = l.assigned_to
      where l.id = ? and l.organization_id = ? and l.deleted_at is null`,
    [id, orgId]
  );
  if (!lead) notFound();

  const notes = all<{ id: string; body: string; created_at: string; author: string | null }>(
    `select n.id, n.body, n.created_at, p.full_name as author from lead_notes n
       left join profiles p on p.id = n.author_id
      where n.lead_id = ? and n.organization_id = ? order by n.created_at desc`,
    [id, orgId]
  );

  const activities = all<{ id: string; summary: string | null; action: string; created_at: string }>(
    `select id, summary, action, created_at from activities
      where organization_id = ? and entity_type = 'lead' and entity_id = ? order by created_at desc limit 15`,
    [orgId, id]
  );

  const proposals = all<{ id: string; title: string; status: string; total_cents: number; created_at: string }>(
    "select id, title, status, total_cents, created_at from proposals where organization_id = ? and lead_id = ? order by created_at desc",
    [orgId, id]
  );

  const members = (await listMembers(orgId)).map((m) => ({ user_id: m.user_id, label: m.full_name ?? m.email }));

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
      <Link href="/leads" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> All leads
      </Link>

      <PageHeader
        title={lead.name}
        description={`${LEAD_STATUS_LABEL[lead.status]} · created ${formatDate(lead.created_at)} · source ${lead.source.replace(/_/g, " ")}`}
        actions={
          <>
            <Link href={`/proposals/new?lead=${lead.id}`}><Button size="sm" variant="outline">Create proposal</Button></Link>
            <Link href={`/ai-assistant?lead=${lead.id}`}><Button size="sm" variant="outline">Draft message</Button></Link>
            {lead.customer_id ? (
              <Link href={`/customers/${lead.customer_id}`}>
                <Button size="sm" variant="outline">View customer</Button>
              </Link>
            ) : (
              <form action={convertLeadToCustomerAction}>
                <input type="hidden" name="lead_id" value={lead.id} />
                <Button size="sm" variant="outline" type="submit">Convert to customer</Button>
              </form>
            )}
            <form action={deleteLeadAction}>
              <input type="hidden" name="lead_id" value={lead.id} />
              <Button size="sm" variant="danger" type="submit"><Trash2 className="h-4 w-4" /> Delete</Button>
            </form>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Contact details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Detail icon={Mail} label="Email" value={lead.email ?? "—"} />
              <Detail icon={Phone} label="Phone" value={lead.phone ?? "—"} />
              <Detail icon={Building2} label="Company" value={lead.company ?? "—"} />
              <Detail icon={Building2} label="Estimated value" value={formatMoney(lead.value_cents)} />
              <div className="sm:col-span-2">
                <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--fg-muted))]">Notes</p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{lead.notes ?? "No notes yet."}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>AI qualification</CardTitle>
              <CardDescription>
                {lead.ai_scored_at
                  ? `Last scored ${relativeTime(lead.ai_scored_at)}`
                  : "Not scored yet — run a score to get a recommended next action."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {lead.ai_score !== null ? (
                <>
                  <div className="flex items-center gap-3">
                    <span className="text-3xl font-bold">{lead.ai_score}</span>
                    <Badge tone={lead.ai_score >= 70 ? "success" : lead.ai_score >= 40 ? "warning" : "danger"}>
                      {lead.ai_score >= 70 ? "Hot" : lead.ai_score >= 40 ? "Warm" : "Cold"}
                    </Badge>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-[hsl(var(--fg-muted))]">{lead.ai_score_reason}</p>
                  {lead.ai_next_action ? (
                    <Alert tone="info" title="Suggested next action">{lead.ai_next_action}</Alert>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-[hsl(var(--fg-muted))]">No score on record.</p>
              )}
              <ScoreLeadButton leadId={lead.id} />
              <p className="text-xs text-[hsl(var(--fg-muted))]">
                If no AI provider key is configured, scoring falls back to a transparent rule-based model and says so.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
              <CardDescription>{notes.length} note{notes.length === 1 ? "" : "s"} on this lead.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <NoteForm leadId={lead.id} />
              <div className="space-y-3">
                {notes.length === 0 ? (
                  <p className="text-sm text-[hsl(var(--fg-muted))]">No notes yet.</p>
                ) : (
                  notes.map((n) => (
                    <div key={n.id} className="rounded-lg border border-[hsl(var(--border))] p-3">
                      <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                      <p className="mt-1 text-xs text-[hsl(var(--fg-muted))]">
                        {n.author ?? "Someone"} · {relativeTime(n.created_at)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Proposals for this lead</CardTitle>
            </CardHeader>
            <CardContent>
              {proposals.length === 0 ? (
                <p className="text-sm text-[hsl(var(--fg-muted))]">No proposals yet. <Link href={`/proposals/new?lead=${lead.id}`} className="underline">Create one</Link>.</p>
              ) : (
                <Table>
                  <THead>
                    <TR><TH>Title</TH><TH>Status</TH><TH className="text-right">Total</TH><TH>Created</TH></TR>
                  </THead>
                  <TBody>
                    {proposals.map((p) => (
                      <TR key={p.id}>
                        <TD><Link href={`/proposals/${p.id}`} className="font-medium hover:underline">{p.title}</Link></TD>
                        <TD className="capitalize">{p.status}</TD>
                        <TD className="text-right">{formatMoney(p.total_cents)}</TD>
                        <TD className="text-[hsl(var(--fg-muted))]">{formatDate(p.created_at)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Pipeline</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <UpdateLeadForm
                leadId={lead.id}
                status={lead.status}
                value={(lead.value_cents / 100).toFixed(2)}
                followUp={lead.next_follow_up_at ? lead.next_follow_up_at.slice(0, 10) : ""}
              />
              <div className="border-t border-[hsl(var(--border))] pt-4">
                <AssignForm leadId={lead.id} members={members} current={lead.assigned_to} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {activities.length === 0 ? (
                <p className="text-sm text-[hsl(var(--fg-muted))]">No activity recorded yet.</p>
              ) : (
                activities.map((a) => (
                  <div key={a.id} className="text-sm">
                    <p>{a.summary ?? a.action}</p>
                    <p className="text-xs text-[hsl(var(--fg-muted))]">{relativeTime(a.created_at)}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function Detail({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--fg-muted))]" />
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--fg-muted))]">{label}</p>
        <p className="text-sm">{value}</p>
      </div>
    </div>
  );
}
