import type { Metadata } from "next";
import Link from "next/link";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/table";
import { listNotifications, unreadCount } from "@/lib/notifications";
import { markAllNotificationsReadAction, markNotificationReadAction } from "@/lib/actions/notifications";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Notifications", robots: { index: false } };

const TONE: Record<string, "neutral" | "success" | "warning" | "danger" | "info"> = {
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
};

export default async function NotificationsPage() {
  const ctx = await loadAppContext();
  const items = listNotifications(ctx.orgId, ctx.user.id, 100);
  const unread = unreadCount(ctx.orgId, ctx.user.id);

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      canWriteLeads={ctx.can("lead:write")}
      planName={ctx.plan.name}
      impersonation={ctx.impersonation}
      trialDaysLeft={ctx.trialDaysLeft}
      unreadNotifications={unread}
    >
      <PageHeader
        title="Notifications"
        description="Assignments, approvals, automation failures and billing events for this workspace."
        actions={
          unread > 0 ? (
            <form action={markAllNotificationsReadAction}>
              <Button type="submit" size="sm" variant="outline">Mark all read</Button>
            </form>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Unread" value={String(unread)} tone={unread ? "warn" : "default"} />
        <StatCard label="Total" value={String(items.length)} />
        <StatCard label="Workspace" value={ctx.membership.organization_name} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Newest first. Each entry links to the record it is about.</CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              description="You will see a notification when a lead is assigned to you, an email needs approval, or an automation fails."
            />
          ) : (
            <ul className="space-y-2">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={`rounded-lg border p-3 ${
                    n.read_at
                      ? "border-[hsl(var(--border))] opacity-70"
                      : "border-brand-200 bg-brand-50/40 dark:border-brand-900 dark:bg-brand-950/20"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium">
                        {n.title}
                        <Badge tone={TONE[n.level] ?? "neutral"}>{n.type}</Badge>
                        {n.read_at ? null : <Badge tone="brand">new</Badge>}
                      </p>
                      {n.body ? <p className="mt-1 text-sm text-[hsl(var(--fg-muted))]">{n.body}</p> : null}
                      <p className="mt-1 text-xs text-[hsl(var(--fg-muted))]">{relativeTime(n.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {n.href ? (
                        <Link className="text-sm underline" href={n.href}>Open</Link>
                      ) : null}
                      {n.read_at ? null : (
                        <form action={markNotificationReadAction}>
                          <input type="hidden" name="id" value={n.id} />
                          <Button type="submit" size="sm" variant="ghost">Mark read</Button>
                        </form>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
