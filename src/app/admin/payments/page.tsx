import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { requireSuperAdmin } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ReviewClaimForm } from "@/components/admin/platform-payment-forms";
import { listAllClaims } from "@/lib/platform-payments-server";
import { all } from "@/lib/db";
import { formatDate, relativeTime } from "@/lib/utils";
import { methodLabel } from "@/lib/platform-payments";

/**
 * /admin/payments — all money in one place, with the two flows kept apart.
 *
 * `platform_payment_claims` is a customer paying BizPilot. `local_payment_requests` is
 * a customer's own client paying *them*. Mixing the two tables on one screen is how a
 * product shows a customer's money as its own revenue, so they are separate tabs and
 * separate queries — never a union.
 *
 * The workspace tab is a monitor. The one action available there (escalated approval)
 * calls the same `approveLocalPaymentRequest` the customer's own page calls, so a
 * payment can never be activated twice by two different code paths.
 */

export const metadata: Metadata = { title: "Payments", robots: { index: false } };
export const dynamic = "force-dynamic";

const TABS = [
  { key: "platform", label: "Platform (to you)" },
  { key: "workspace", label: "Workspace payments" },
  { key: "refunds", label: "Refunds" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const STATUS_TONE: Record<string, "warning" | "success" | "danger" | "neutral"> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export default async function AdminPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireSuperAdmin();
  const ctx = await loadAppContext();
  const sp = await searchParams;
  const tab: TabKey = TABS.some((t) => t.key === sp.tab) ? (sp.tab as TabKey) : "platform";

  const platformClaims = listAllClaims(undefined, 60);
  const pending = platformClaims.filter((claim) => claim.status === "pending");
  const decided = platformClaims.filter((claim) => claim.status !== "pending");

  const workspaceRequests = all<{
    id: string; organization_name: string; plan_code: string; billing_cycle: string; amount_cents: number;
    currency: string; reference: string | null; status: string; submitted_at: string; gateway_provider: string | null;
  }>(
    `select r.id, o.name as organization_name, r.plan_code, r.billing_cycle, r.amount_cents, r.currency,
            r.reference, r.status, r.submitted_at, r.gateway_provider
       from local_payment_requests r join organizations o on o.id = r.organization_id
      order by r.submitted_at desc limit 60`
  );

  const refunds = all<{
    id: string; organization_name: string; amount_cents: number; reason: string | null; created_at: string;
  }>(
    `select f.id, o.name as organization_name, f.amount_cents, f.reason, f.created_at
       from payment_refunds f
       join organizations o on o.id = f.organization_id
      order by f.created_at desc limit 60`
  );

  const approvedCents = platformClaims
    .filter((claim) => claim.status === "approved")
    .reduce((sum, claim) => sum + claim.amount_cents, 0);

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
        title="Payments"
        description="Two flows, deliberately separate: money sent to you, and money your customers collect from their own clients."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/platform-payments"><Button size="sm" variant="outline">Payout settings</Button></Link>
            <Link href="/admin/workspaces"><Button size="sm" variant="outline">Workspaces</Button></Link>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((entry) => (
          <Link key={entry.key} href={`/admin/payments?tab=${entry.key}`}>
            <Button size="sm" variant={tab === entry.key ? "default" : "outline"}>
              {entry.label}
              {entry.key === "platform" && pending.length > 0 ? ` (${pending.length})` : ""}
            </Button>
          </Link>
        ))}
      </div>

      {tab === "platform" ? (
        <>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Waiting for approval"
              value={String(pending.length)}
              hint={`Rs ${Math.round(pending.reduce((sum, claim) => sum + claim.amount_cents, 0) / 100).toLocaleString()} claimed`}
              tone={pending.length > 0 ? "warn" : "default"}
            />
            <StatCard label="Approved (last 60)" value={`Rs ${Math.round(approvedCents / 100).toLocaleString()}`} />
            <StatCard
              label="Rejected (last 60)"
              value={String(platformClaims.filter((claim) => claim.status === "rejected").length)}
            />
          </div>

          <Card className="mb-4">
            <CardHeader>
              <CardTitle>Pending claims</CardTitle>
              <CardDescription>
                Same approve/reject actions as the payout page — one code path, so a plan can never be activated twice
                from two screens.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {pending.length === 0 ? (
                <EmptyState title="Nothing waiting" description="Every submitted platform payment has been reviewed." />
              ) : (
                <div className="space-y-4">
                  {pending.map((claim) => (
                    <div key={claim.id} className="rounded-lg border border-[hsl(var(--border))] p-3">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-medium">
                            {claim.organization_name}{" "}
                            <span className="text-[hsl(var(--fg-muted))]">· {claim.plan_code} · {claim.billing_cycle}</span>
                          </p>
                          <p className="text-sm text-[hsl(var(--fg-muted))]">
                            Rs {Math.round(claim.amount_cents / 100).toLocaleString()} · {methodLabel(claim.method_kind)} · ref{" "}
                            <code>{claim.reference}</code> · {relativeTime(claim.submitted_at)}
                          </p>
                        </div>
                        {claim.founding_member === 1 ? <Badge tone="brand">founding price</Badge> : null}
                      </div>
                      <ReviewClaimForm claimId={claim.id} amountPkr={Math.round(claim.amount_cents / 100)} />
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent decisions</CardTitle>
              <CardDescription>Self-approved rows are flagged — a solo platform still keeps an honest trail.</CardDescription>
            </CardHeader>
            <CardContent>
              {decided.length === 0 ? (
                <EmptyState title="Nothing reviewed yet" description="Approved and rejected claims appear here." />
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Workspace</TH>
                      <TH>Plan</TH>
                      <TH>Amount</TH>
                      <TH>Status</TH>
                      <TH>Note</TH>
                      <TH>Reviewed</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {decided.slice(0, 30).map((claim) => (
                      <TR key={claim.id}>
                        <TD>{claim.organization_name}</TD>
                        <TD>{claim.plan_code} · {claim.billing_cycle}</TD>
                        <TD>Rs {Math.round(claim.amount_cents / 100).toLocaleString()}</TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            <Badge tone={STATUS_TONE[claim.status] ?? "neutral"}>{claim.status}</Badge>
                            {claim.self_approved === 1 ? <Badge tone="warning">self-approved</Badge> : null}
                          </div>
                        </TD>
                        <TD className="max-w-[220px] truncate">{claim.review_note ?? "—"}</TD>
                        <TD className="text-xs">{claim.reviewed_at ? relativeTime(claim.reviewed_at) : "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}

      {tab === "workspace" ? (
        <Card>
          <CardHeader>
            <CardTitle>Workspace payments (monitor)</CardTitle>
            <CardDescription>
              Your customers collecting from their own clients. Approval normally happens inside their workspace; this
              view exists for support and audit, and is read-only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-3">
              <Alert tone="info" title="Read-only by design">
                A payment is activated by the workspace owner or a verified gateway webhook. An admin approval path here
                would be a second way to grant access, so there is deliberately none.
              </Alert>
            </div>
            {workspaceRequests.length === 0 ? (
              <EmptyState title="No workspace payments yet" description="When a customer's client pays them, the claim shows up here." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Workspace</TH>
                    <TH>Plan</TH>
                    <TH>Amount</TH>
                    <TH>Reference</TH>
                    <TH>Status</TH>
                    <TH>Verified by</TH>
                    <TH>Submitted</TH>
                  </TR>
                </THead>
                <TBody>
                  {workspaceRequests.map((request) => (
                    <TR key={request.id}>
                      <TD>{request.organization_name}</TD>
                      <TD>{request.plan_code} · {request.billing_cycle}</TD>
                      <TD>Rs {Math.round(request.amount_cents / 100).toLocaleString()}</TD>
                      <TD><code>{request.reference ?? "—"}</code></TD>
                      <TD><Badge tone={STATUS_TONE[request.status] ?? "neutral"}>{request.status}</Badge></TD>
                      <TD className="text-xs">{request.gateway_provider ?? "manual"}</TD>
                      <TD className="text-xs">{relativeTime(request.submitted_at)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {tab === "refunds" ? (
        <Card>
          <CardHeader>
            <CardTitle>Refunds</CardTitle>
            <CardDescription>Issued inside the workspace that received the money. Read-only here.</CardDescription>
          </CardHeader>
          <CardContent>
            {refunds.length === 0 ? (
              <EmptyState title="No refunds" description="Refunds issued by a workspace appear here for audit." />
            ) : (
              <Table>
                <THead>
                  <TR>
                    <TH>Workspace</TH>
                    <TH>Amount</TH>
                    <TH>Reason</TH>
                    <TH>Issued</TH>
                  </TR>
                </THead>
                <TBody>
                  {refunds.map((refund) => (
                    <TR key={refund.id}>
                      <TD>{refund.organization_name}</TD>
                      <TD>Rs {Math.round(refund.amount_cents / 100).toLocaleString()}</TD>
                      <TD className="max-w-[280px] truncate">{refund.reason ?? "—"}</TD>
                      <TD className="text-xs">{formatDate(refund.created_at)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}
    </AppShell>
  );
}
