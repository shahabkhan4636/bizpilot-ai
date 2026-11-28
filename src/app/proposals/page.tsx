import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { all, get } from "@/lib/db";
import { formatMoney, formatDate, relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Proposals", robots: { index: false } };

export default async function ProposalsPage() {
  const ctx = await loadAppContext();
  const orgId = ctx.orgId;

  const rows = all<{
    id: string; title: string; client_name: string; status: string; total_cents: number; currency: string;
    version: number; share_token: string | null; created_at: string; updated_at: string;
  }>(
    `select id, title, client_name, status, total_cents, currency, version, share_token, created_at, updated_at
       from proposals where organization_id = ? order by created_at desc limit 200`,
    [orgId]
  );

  const stats = get<{ total: number; sent: number; accepted: number; accepted_value: number; open_value: number }>(
    `select count(*) as total,
            sum(case when status='sent' then 1 else 0 end) as sent,
            sum(case when status='accepted' then 1 else 0 end) as accepted,
            coalesce(sum(case when status='accepted' then total_cents else 0 end),0) as accepted_value,
            coalesce(sum(case when status in ('draft','sent') then total_cents else 0 end),0) as open_value
       from proposals where organization_id = ?`,
    [orgId]
  ) ?? { total: 0, sent: 0, accepted: 0, accepted_value: 0, open_value: 0 };

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
        title="Proposals"
        description="Priced proposals with version history, a secure client link and a PDF export."
        actions={
          ctx.can("proposal:write") ? (
            <Link href="/proposals/new"><Button size="sm"><Plus className="h-4 w-4" /> New proposal</Button></Link>
          ) : null
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Proposals" value={String(stats.total)} />
        <StatCard label="Awaiting decision" value={String(stats.sent ?? 0)} />
        <StatCard label="Accepted" value={String(stats.accepted ?? 0)} tone="good" />
        <StatCard label="Accepted value" value={formatMoney(stats.accepted_value)} tone="good" />
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No proposals yet"
            description="Create a proposal with line items, then share a secure link your client can accept or decline."
            action={<Link href="/proposals/new"><Button size="sm">Create the first proposal</Button></Link>}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Proposal</TH><TH>Client</TH><TH>Status</TH><TH>Version</TH>
                <TH className="text-right">Total</TH><TH>Updated</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <Link href={`/proposals/${p.id}`} className="font-medium hover:underline">{p.title}</Link>
                    <p className="text-xs text-[hsl(var(--fg-muted))]">{p.share_token ? "share link active" : "no share link"}</p>
                  </TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{p.client_name}</TD>
                  <TD><StatusBadge status={p.status} /></TD>
                  <TD className="text-[hsl(var(--fg-muted))]">v{p.version}</TD>
                  <TD className="text-right font-medium">{formatMoney(p.total_cents, p.currency)}</TD>
                  <TD className="text-[hsl(var(--fg-muted))]" title={formatDate(p.updated_at)}>{relativeTime(p.updated_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </AppShell>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone = status === "accepted" ? "success" : status === "rejected" ? "danger" : status === "sent" ? "info" : status === "expired" ? "warning" : "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}
