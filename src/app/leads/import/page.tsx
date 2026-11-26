import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportForm } from "@/components/leads/import-form";

export const metadata: Metadata = { title: "Import leads", robots: { index: false } };

export default async function ImportLeadsPage() {
  const ctx = await loadAppContext();
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
        <ArrowLeft className="h-4 w-4" /> Back to leads
      </Link>
      <PageHeader title="Import leads from CSV" description="Every row is validated. Invalid rows are reported, never silently dropped." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Upload or paste</CardTitle>
            <CardDescription>
              {ctx.usage.leads} of {ctx.plan.lead_limit.toLocaleString()} leads used on the {ctx.plan.name} plan — the importer stops at the limit and tells you.
            </CardDescription>
          </CardHeader>
          <CardContent><ImportForm /></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Expected columns</CardTitle>
            <CardDescription>A header row is detected automatically.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ["name", "required unless email present"],
              ["email", "validated"],
              ["phone", "optional"],
              ["company", "optional"],
              ["source", "defaults to import"],
              ["status", "must be a pipeline status"],
              ["value", "number, e.g. 1500.00"],
              ["notes", "free text"],
            ].map(([col, note]) => (
              <div key={col} className="flex items-start justify-between gap-2">
                <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5 text-xs">{col}</code>
                <span className="text-right text-xs text-[hsl(var(--fg-muted))]">{note}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
