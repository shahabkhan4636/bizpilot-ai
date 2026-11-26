import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ProposalEditor } from "@/components/proposals/proposal-editor";
import { all, get } from "@/lib/db";

export const metadata: Metadata = { title: "New proposal", robots: { index: false } };

export default async function NewProposalPage({ searchParams }: { searchParams: Promise<{ lead?: string; customer?: string }> }) {
  const ctx = await loadAppContext();
  const sp = await searchParams;

  const lead = sp.lead
    ? get<{ id: string; name: string; email: string | null; company: string | null }>(
        "select id, name, email, company from leads where id = ? and organization_id = ?",
        [sp.lead, ctx.orgId]
      )
    : null;
  const customer = sp.customer
    ? get<{ id: string; name: string; email: string | null; company: string | null }>(
        "select id, name, email, company from customers where id = ? and organization_id = ?",
        [sp.customer, ctx.orgId]
      )
    : null;

  const customers = all<{ id: string; name: string }>("select id, name from customers where organization_id = ? and deleted_at is null order by name asc limit 200", [ctx.orgId]);
  const leads = all<{ id: string; name: string }>("select id, name from leads where organization_id = ? and deleted_at is null order by created_at desc limit 200", [ctx.orgId]);

  const seed = customer ?? lead;

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      planName={ctx.plan.name}
      trialDaysLeft={ctx.trialDaysLeft}
    >
      <Link href="/proposals" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> All proposals
      </Link>
      <PageHeader title="New proposal" description="Line items, tax and terms — totals are computed server-side." />
      <Card>
        <CardHeader>
          <CardTitle>Proposal details</CardTitle>
          <CardDescription>You can edit this later; each save creates a new version.</CardDescription>
        </CardHeader>
        <CardContent>
          <ProposalEditor
            mode="create"
            items={[]}
            taxPercent={0}
            currency={ctx.membership.currency || "USD"}
            clientName={seed?.name ?? ""}
            clientEmail={seed?.email ?? ""}
            customerId={customer?.id ?? null}
            leadId={lead?.id ?? null}
            customers={customers}
            leads={leads}
          />
        </CardContent>
      </Card>
      <div className="mt-4">
        <Alert tone="info" title="Acceptance is client-only">
          Marking a proposal as sent never marks it accepted. Only the client, from the share link, can accept or decline.
        </Alert>
      </div>
    </AppShell>
  );
}
