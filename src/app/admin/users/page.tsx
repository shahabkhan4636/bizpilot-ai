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
import { Input } from "@/components/ui/input";
import { AdminPager } from "@/components/admin/workspace-forms";
import { listUsers } from "@/lib/admin/workspaces";
import { get } from "@/lib/db";
import { isSuperAdminEmail } from "@/lib/owner";
import { formatDate, relativeTime } from "@/lib/utils";

/**
 * /admin/users — every account on the platform.
 *
 * Read-only on purpose: the way to affect a user's access is through their workspace
 * (plan, suspension), which keeps one path per decision. The columns answer the
 * questions support actually gets: can they sign in, and when did they last do it.
 */

export const metadata: Metadata = { title: "Users", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireSuperAdmin();
  const ctx = await loadAppContext();
  const sp = await searchParams;
  const page = Number(sp.page ?? "1") || 1;
  const { rows, total, perPage } = listUsers({ search: sp.q ?? "", page });

  const counts = {
    users: get<{ c: number }>("select count(*) as c from profiles")?.c ?? 0,
    unverified: get<{ c: number }>("select count(*) as c from profiles where email_verified_at is null")?.c ?? 0,
    activeSessions: get<{ c: number }>("select count(distinct user_id) as c from sessions where expires_at > ?", [
      new Date().toISOString(),
    ])?.c ?? 0,
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
        title="Users"
        description="Accounts, email verification and sign-in activity. Changes are made on the workspace, so there is one path per decision."
        actions={
          <div className="flex gap-2">
            <Link href="/admin/workspaces"><Button size="sm" variant="outline">Workspaces</Button></Link>
            <Link href="/admin/payments"><Button size="sm" variant="outline">Payments</Button></Link>
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Accounts" value={String(counts.users)} />
        <StatCard label="Email unverified" value={String(counts.unverified)} tone={counts.unverified > 0 ? "warn" : "default"} />
        <StatCard label="Signed in now" value={String(counts.activeSessions)} hint="live sessions" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Accounts</CardTitle>
          <CardDescription>Search matches email or name. Newest first.</CardDescription>
          <form className="mt-3 flex flex-wrap items-end gap-2" action="/admin/users">
            <div className="space-y-1">
              <label htmlFor="user-q" className="text-xs text-[hsl(var(--fg-muted))]">Search</label>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-[hsl(var(--fg-muted))]" />
                <Input id="user-q" name="q" defaultValue={sp.q ?? ""} placeholder="email or name" className="h-9 w-64 pl-8" />
              </div>
            </div>
            <Button type="submit" size="sm" variant="secondary">Search</Button>
          </form>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState title="No accounts match" description="Try a different search." />
          ) : (
            <>
              <Table>
                <THead>
                  <TR>
                    <TH>Email</TH>
                    <TH>Role</TH>
                    <TH>Workspaces</TH>
                    <TH>Email verified</TH>
                    <TH>Last signed in</TH>
                    <TH>Created</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((user) => (
                    <TR key={user.id}>
                      <TD className="font-medium">
                        <span className="flex flex-wrap items-center gap-1">
                          {user.email}
                          {isSuperAdminEmail(user.email) ? <Badge tone="brand">platform owner</Badge> : null}
                        </span>
                        {user.full_name ? <p className="text-xs text-[hsl(var(--fg-muted))]">{user.full_name}</p> : null}
                      </TD>
                      <TD className="capitalize">{user.role ?? "—"}</TD>
                      <TD>{user.workspaces}</TD>
                      <TD>
                        {user.email_verified_at ? (
                          <Badge tone="success">verified</Badge>
                        ) : (
                          <Badge tone="warning">pending</Badge>
                        )}
                      </TD>
                      <TD className="text-xs">{user.last_session_at ? relativeTime(user.last_session_at) : "never"}</TD>
                      <TD className="text-[hsl(var(--fg-muted))]">{formatDate(user.created_at)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <AdminPager page={page} perPage={perPage} total={total} basePath="/admin/users" query={{ q: sp.q ?? "" }} />
            </>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
