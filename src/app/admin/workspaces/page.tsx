import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { requireSuperAdmin } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Input, Select } from "@/components/ui/input";
import { AdminPager } from "@/components/admin/workspace-forms";
import { listWorkspaces } from "@/lib/admin/workspaces";
import { isPlatformOwnerWorkspace } from "@/lib/plans";
import { all, get } from "@/lib/db";
import { formatDate } from "@/lib/utils";

/**
 * /admin/workspaces — every customer workspace.
 *
 * Read-only by design: nothing destructive lives on the list. Opening a workspace is
 * the only way to suspend, change plan or impersonate, so a misclick on a table row
 * cannot take away someone's access.
 */

export const metadata: Metadata = { title: "Workspaces", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminWorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; plan?: string; status?: string; page?: string }>;
}) {
  await requireSuperAdmin();
  const ctx = await loadAppContext();
  const sp = await searchParams;

  const status = (sp.status ?? "all") as "all" | "active" | "suspended" | "at_limit";
  const page = Number(sp.page ?? "1") || 1;
  const { rows, total, perPage } = listWorkspaces({
    search: sp.q ?? "",
    plan: sp.plan ?? "all",
    status,
    page,
  });

  const plans = all<{ code: string; name: string }>("select code, name from plans order by sort_order asc");
  const ownerIds = new Set(rows.filter((row) => isPlatformOwnerWorkspace(row.id)).map((row) => row.id));

  const counts = {
    workspaces: get<{ c: number }>("select count(*) as c from organizations")?.c ?? 0,
    suspended: get<{ c: number }>("select count(*) as c from organizations where suspended_at is not null")?.c ?? 0,
    pendingClaims: get<{ c: number }>("select count(*) as c from platform_payment_claims where status = 'pending'")?.c ?? 0,
    founding: get<{ c: number }>("select count(*) as c from founding_memberships")?.c ?? 0,
  };

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
      <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Admin
      </Link>

      <PageHeader
        title="Workspaces"
        description="Every customer workspace with its plan, usage and suspension state. Open one to act on it."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/users"><Button size="sm" variant="outline">Users</Button></Link>
            <Link href="/admin/payments"><Button size="sm" variant="outline">Payments</Button></Link>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Workspaces" value={String(counts.workspaces)} />
        <StatCard label="Suspended" value={String(counts.suspended)} tone={counts.suspended > 0 ? "warn" : "default"} />
        <StatCard label="Claims waiting" value={String(counts.pendingClaims)} hint="platform payments" />
        <StatCard label="Founding Members" value={String(counts.founding)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All workspaces</CardTitle>
          <CardDescription>Filtering happens in SQL, so the page stays fast as customers are added.</CardDescription>
          <form className="mt-3 flex flex-wrap items-end gap-2" action="/admin/workspaces">
            <div className="space-y-1">
              <label htmlFor="ws-q" className="text-xs text-[hsl(var(--fg-muted))]">Search</label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-[hsl(var(--fg-muted))]" />
                <Input id="ws-q" name="q" defaultValue={sp.q ?? ""} placeholder="name, slug or owner email" className="h-9 w-64 pl-8" />
              </div>
            </div>
            <div className="space-y-1">
              <label htmlFor="ws-plan" className="text-xs text-[hsl(var(--fg-muted))]">Plan</label>
              <Select id="ws-plan" name="plan" defaultValue={sp.plan ?? "all"} className="h-9 w-40">
                <option value="all">All plans</option>
                {plans.map((plan) => (
                  <option key={plan.code} value={plan.code}>{plan.name}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <label htmlFor="ws-status" className="text-xs text-[hsl(var(--fg-muted))]">Status</label>
              <Select id="ws-status" name="status" defaultValue={status} className="h-9 w-40">
                <option value="all">Any status</option>
                <option value="active">Active</option>
                <option value="suspended">Suspended</option>
                <option value="at_limit">At lead limit</option>
              </Select>
            </div>
            <Button type="submit" size="sm" variant="secondary">Filter</Button>
          </form>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState title="No workspaces match" description="Clear the filters, or wait for the first signup." />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Workspace</TH>
                    <TH>Plan</TH>
                    <TH>Members</TH>
                    <TH>Leads</TH>
                    <TH>Status</TH>
                    <TH>Created</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {rows.map((row) => (
                    <TR key={row.id}>
                      <TD className="font-medium">
                        <span className="flex flex-wrap items-center gap-1">
                          {row.name}
                          {ownerIds.has(row.id) ? <Badge tone="brand">Platform owner</Badge> : null}
                          {row.founding === 1 ? <Badge tone="info">Founding</Badge> : null}
                        </span>
                        <p className="text-xs text-[hsl(var(--fg-muted))]">
                          {row.slug}
                          {row.owner_email ? ` · ${row.owner_email}` : ""}
                        </p>
                      </TD>
                      <TD>
                        {ownerIds.has(row.id) ? "unlimited" : (row.plan_name ?? row.plan_code ?? "—")}
                        <p className="text-xs text-[hsl(var(--fg-muted))]">
                          {ownerIds.has(row.id) ? "never billed" : (row.status ?? "no subscription")}
                        </p>
                      </TD>
                      <TD>{row.members}</TD>
                      <TD>{row.leads}</TD>
                      <TD>
                        {row.suspended_at ? <Badge tone="danger">suspended</Badge> : <Badge tone="success">active</Badge>}
                      </TD>
                      <TD className="text-[hsl(var(--fg-muted))]">{formatDate(row.created_at)}</TD>
                      <TD>
                        <Link href={`/admin/workspaces/${row.id}`}>
                          <Button size="sm" variant="outline">Open</Button>
                        </Link>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <AdminPager
                page={page}
                perPage={perPage}
                total={total}
                basePath="/admin/workspaces"
                query={{ q: sp.q ?? "", plan: sp.plan ?? "all", status }}
              />
            </>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
