import type { Metadata } from "next";
import Link from "next/link";
import { Download, Upload } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { LeadFilters } from "@/components/leads/lead-filters";
import { NewLeadPanel } from "@/components/leads/lead-forms";
import { listMembers } from "@/lib/queries";
import { all, get } from "@/lib/db";
import { formatMoney, formatDate } from "@/lib/utils";
import { LEAD_STATUS_LABEL, type LeadStatus } from "@/lib/csv";
import { limitLabel } from "@/lib/limits";

export const metadata: Metadata = { title: "Leads", robots: { index: false } };

type LeadRow = {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  status: LeadStatus;
  source: string;
  value_cents: number;
  ai_score: number | null;
  next_follow_up_at: string | null;
  created_at: string;
  owner_name: string | null;
};

const SORTS: Record<string, string> = {
  created_desc: "l.created_at desc",
  created_asc: "l.created_at asc",
  value_desc: "l.value_cents desc",
  score_desc: "coalesce(l.ai_score,-1) desc",
  name_asc: "l.name asc",
  followup_asc: "l.next_follow_up_at asc nulls last",
};

const PER_PAGE = 20;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; owner?: string; sort?: string; page?: string; new?: string }>;
}) {
  const ctx = await loadAppContext();
  const sp = await searchParams;
  const orgId = ctx.orgId;

  const members = (await listMembers(orgId)).map((m) => ({
    user_id: m.user_id,
    label: m.full_name ?? m.email,
  }));

  const where: string[] = ["l.organization_id = ?", "l.deleted_at is null"];
  const params: unknown[] = [orgId];

  if (sp.q) {
    where.push("(l.name like ? or l.email like ? or l.company like ? or l.phone like ?)");
    const like = `%${sp.q}%`;
    params.push(like, like, like, like);
  }
  if (sp.status && sp.status in LEAD_STATUS_LABEL) {
    where.push("l.status = ?");
    params.push(sp.status);
  }
  if (sp.owner) {
    where.push("l.assigned_to = ?");
    params.push(sp.owner);
  }

  const orderBy = SORTS[sp.sort ?? "created_desc"] ?? SORTS.created_desc;

  const total = get<{ c: number }>(`select count(*) as c from leads l where ${where.join(" and ")}`, params)?.c ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  // `?page=` is untrusted input. Bound it by the real page count as well as an
  // absolute ceiling, so a hand-edited URL cannot ask for a deep offset or leave
  // the user on "Page 999 of 3" with no way back.
  const requestedPage = Math.trunc(Number(sp.page ?? 1)) || 1;
  const page = Math.min(pages, 10_000, Math.max(1, requestedPage));

  const rows = all<LeadRow>(
    `select l.id, l.name, l.email, l.company, l.status, l.source, l.value_cents, l.ai_score,
            l.next_follow_up_at, l.created_at, p.full_name as owner_name
       from leads l left join profiles p on p.id = l.assigned_to
      where ${where.join(" and ")}
      order by ${orderBy}
      limit ? offset ?`,
    [...params, PER_PAGE, (page - 1) * PER_PAGE]
  );
  const totals = get<{ pipeline: number; won: number }>(
    `select coalesce(sum(case when status not in ('won','lost') then value_cents else 0 end),0) as pipeline,
            coalesce(sum(case when status='won' then value_cents else 0 end),0) as won
       from leads where organization_id = ? and deleted_at is null`,
    [orgId]
  ) ?? { pipeline: 0, won: 0 };

  const queryFor = (p: number) => {
    const usp = new URLSearchParams();
    if (sp.q) usp.set("q", sp.q);
    if (sp.status) usp.set("status", sp.status);
    if (sp.owner) usp.set("owner", sp.owner);
    if (sp.sort) usp.set("sort", sp.sort);
    usp.set("page", String(p));
    return `/leads?${usp.toString()}`;
  };
  const exportQuery = new URLSearchParams({ ...(sp.q ? { q: sp.q } : {}), ...(sp.status ? { status: sp.status } : {}), ...(sp.owner ? { owner: sp.owner } : {}) }).toString();

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
        title="Leads"
        description={`${total} lead${total === 1 ? "" : "s"} in this view · ${ctx.usage.leads} of ${limitLabel(ctx.plan.lead_limit)} used on the ${ctx.plan.name} plan`}
        actions={
          <>
            <a
              href={exportQuery ? `/api/leads/export?${exportQuery}` : "/api/leads/export"}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Download className="h-4 w-4" /> Export CSV
            </a>
            {ctx.can("lead:write") ? (
              <Link href="/leads/import"><Button size="sm" variant="outline"><Upload className="h-4 w-4" /> Import</Button></Link>
            ) : null}
          </>
        }
      />

      {ctx.usage.leads >= ctx.plan.lead_limit ? (
        <div className="mb-4">
          <Alert tone="danger" title="Lead limit reached">
            You are at {ctx.usage.leads} of {limitLabel(ctx.plan.lead_limit)} leads. <Link href="/billing" className="underline">Upgrade your plan</Link> to keep adding records.
          </Alert>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Open pipeline" value={formatMoney(totals.pipeline)} />
        <StatCard label="Won value" value={formatMoney(totals.won)} tone="good" />
        <StatCard label="Leads in workspace" value={String(ctx.usage.leads)} hint={`Limit ${limitLabel(ctx.plan.lead_limit)}`} />
      </div>

      <div className="mb-4">
        {ctx.can("lead:write") ? (
          <NewLeadPanel members={members} defaultOpen={sp.new === "1"} />
        ) : (
          <Alert tone="info" title="Read-only access">
            Your role ({ctx.membership.role}) can view and export leads but not change them. Ask a
            workspace admin if you need edit rights.
          </Alert>
        )}
      </div>

      <div className="mb-3"><LeadFilters members={members} /></div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={ctx.usage.leads === 0 ? "No leads yet" : "No leads match these filters"}
            description={
              ctx.usage.leads === 0
                ? "Add your first lead or import a CSV to start filling the pipeline. Nothing here is pre-filled with fake data."
                : "Try clearing the search box, status or owner filters."
            }
            action={
              ctx.can("lead:write") ? (
                <Link href="/leads/import"><Button size="sm" variant="outline">Import CSV</Button></Link>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Lead</TH>
                <TH>Status</TH>
                <TH>Source</TH>
                <TH className="text-right">Value</TH>
                <TH className="text-right">AI score</TH>
                <TH>Owner</TH>
                <TH>Follow-up</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((l) => (
                <TR key={l.id}>
                  <TD>
                    <Link href={`/leads/${l.id}`} className="font-medium hover:underline">{l.name}</Link>
                    <p className="text-xs text-[hsl(var(--fg-muted))]">{l.email ?? l.company ?? "—"}</p>
                  </TD>
                  <TD><StatusBadge status={l.status} /></TD>
                  <TD className="capitalize text-[hsl(var(--fg-muted))]">{l.source.replace(/_/g, " ")}</TD>
                  <TD className="text-right font-medium">{formatMoney(l.value_cents)}</TD>
                  <TD className="text-right">
                    {l.ai_score === null ? <span className="text-xs text-[hsl(var(--fg-muted))]">not scored</span> : <ScorePill score={l.ai_score} />}
                  </TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{l.owner_name ?? "Unassigned"}</TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{l.next_follow_up_at ? formatDate(l.next_follow_up_at) : "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <p className="text-[hsl(var(--fg-muted))]">Page {page} of {pages}</p>
          <div className="flex gap-2">
            {page > 1 ? <Link href={queryFor(page - 1)}><Button size="sm" variant="outline">Previous</Button></Link> : null}
            {page < pages ? <Link href={queryFor(page + 1)}><Button size="sm" variant="outline">Next</Button></Link> : null}
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

function StatusBadge({ status }: { status: LeadStatus }) {
  const tone =
    status === "won" ? "success" : status === "lost" ? "danger" : status === "new" ? "info" : status === "negotiation" ? "warning" : "brand";
  return <Badge tone={tone}>{LEAD_STATUS_LABEL[status]}</Badge>;
}

function ScorePill({ score }: { score: number }) {
  const tone = score >= 70 ? "success" : score >= 40 ? "warning" : "danger";
  return <Badge tone={tone}>{score}</Badge>;
}
