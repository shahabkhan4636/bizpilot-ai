import type { Metadata } from "next";
import Link from "next/link";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { NewCustomerPanel } from "@/components/customers/customer-forms";
import { all, get } from "@/lib/db";
import { formatMoney, formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Customers", robots: { index: false } };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await loadAppContext();
  const { q } = await searchParams;
  const orgId = ctx.orgId;

  const where = ["c.organization_id = ?", "c.deleted_at is null"];
  const params: unknown[] = [orgId];
  if (q) {
    where.push("(c.name like ? or c.email like ? or c.company like ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const rows = all<{
    id: string; name: string; email: string | null; company: string | null; created_at: string;
    open_leads: number; proposals: number; accepted_cents: number;
  }>(
    `select c.id, c.name, c.email, c.company, c.created_at,
            (select count(*) from leads l where l.customer_id = c.id and l.deleted_at is null) as open_leads,
            (select count(*) from proposals p where p.customer_id = c.id) as proposals,
            (select coalesce(sum(total_cents),0) from proposals p where p.customer_id = c.id and p.status = 'accepted') as accepted_cents
       from customers c where ${where.join(" and ")} order by c.created_at desc limit 200`,
    params
  );

  const stats = get<{ total: number; with_proposals: number; accepted_value: number }>(
    `select count(*) as total,
            (select count(distinct customer_id) from proposals where organization_id = ? and customer_id is not null) as with_proposals,
            (select coalesce(sum(total_cents),0) from proposals where organization_id = ? and status = 'accepted') as accepted_value
       from customers where organization_id = ? and deleted_at is null`,
    [orgId, orgId, orgId]
  ) ?? { total: 0, with_proposals: 0, accepted_value: 0 };

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      planName={ctx.plan.name}
      trialDaysLeft={ctx.trialDaysLeft}
    >
      <PageHeader title="Customers" description="People and companies you have already won. Convert a won lead or add one manually." />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Customers" value={String(stats.total)} />
        <StatCard label="With proposals" value={String(stats.with_proposals)} />
        <StatCard label="Accepted proposal value" value={formatMoney(stats.accepted_value)} tone="good" />
      </div>

      <div className="mb-4"><NewCustomerPanel /></div>

      <form className="mb-3 flex gap-2" action="/customers">
        <Input name="q" defaultValue={q ?? ""} placeholder="Search customers…" aria-label="Search customers" className="max-w-sm" />
        <Button type="submit" variant="outline" size="sm">Search</Button>
        {q ? <Link href="/customers"><Button type="button" variant="ghost" size="sm">Clear</Button></Link> : null}
      </form>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title={q ? "No customers match that search" : "No customers yet"}
            description={q ? "Try a different name, email or company." : "Convert a won lead from the leads page, or add a customer manually above."}
            action={<Link href="/leads"><Button size="sm" variant="outline">Go to leads</Button></Link>}
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Customer</TH>
                <TH>Company</TH>
                <TH className="text-right">Leads</TH>
                <TH className="text-right">Proposals</TH>
                <TH className="text-right">Accepted value</TH>
                <TH>Added</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link href={`/customers/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                    <p className="text-xs text-[hsl(var(--fg-muted))]">{c.email ?? "—"}</p>
                  </TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{c.company ?? "—"}</TD>
                  <TD className="text-right"><Badge>{c.open_leads}</Badge></TD>
                  <TD className="text-right"><Badge>{c.proposals}</Badge></TD>
                  <TD className="text-right font-medium">{formatMoney(c.accepted_cents)}</TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{formatDate(c.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </AppShell>
  );
}
