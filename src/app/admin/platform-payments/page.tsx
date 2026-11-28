import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Crown, Wallet } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { requireSuperAdmin } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { PlatformSettingsForm, ReviewClaimForm } from "@/components/admin/platform-payment-forms";
import {
  foundingGrantedCount,
  getPlatformSettings,
  listAllClaims,
} from "@/lib/platform-payments-server";
import { foundingSlotsLeft, isPlatformConfigured, methodLabel, platformMethods } from "@/lib/platform-payments";
import { all } from "@/lib/db";
import { formatDate, relativeTime } from "@/lib/utils";

/**
 * /admin/platform-payments — customers paying *the platform*.
 *
 * This is where money aimed at the owner lands, and it is deliberately separate from
 * `/billing/local`, which is where a customer's own clients pay *them*. The payout
 * numbers on this page are typed by the owner and stored in `platform_settings`; no
 * wallet, IBAN or holder name exists anywhere in the source tree.
 */

export const metadata: Metadata = { title: "Platform payments", robots: { index: false } };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "warning" | "success" | "danger" | "neutral"> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export default async function AdminPlatformPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ reviewed?: string }>;
}) {
  await requireSuperAdmin();
  const { reviewed } = await searchParams;
  const ctx = await loadAppContext();

  const settings = getPlatformSettings();
  const configured = isPlatformConfigured(settings);
  const methods = platformMethods(settings);
  const pending = listAllClaims("pending", 50);
  const recent = listAllClaims(undefined, 40).filter((claim) => claim.status !== "pending");
  const granted = foundingGrantedCount();
  const slotsLeft = foundingSlotsLeft(settings, granted);

  const founding = all<{ organization_id: string; organization_name: string; locked_price_cents: number; member_limit: number; source: string; granted_at: string }>(
    `select f.organization_id, o.name as organization_name, f.locked_price_cents, f.member_limit, f.source, f.granted_at
       from founding_memberships f join organizations o on o.id = f.organization_id
      order by f.granted_at desc limit 20`
  );

  const pendingValue = pending.reduce((sum, claim) => sum + claim.amount_cents, 0);

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
        title="Platform payments"
        description="Money sent to you for BizPilot subscriptions. Approving here activates the plan and locks a Founding Member price."
      />

      {reviewed === "approve" ? (
        <div className="mb-4">
          <Alert tone="success" title="Claim approved">
            The plan is active from now and the workspace has been notified. If a Founding slot was open, the price is now
            locked for that workspace.
          </Alert>
        </div>
      ) : null}
      {reviewed === "reject" ? (
        <div className="mb-4">
          <Alert tone="warning" title="Claim rejected">
            The workspace keeps its current plan and can see your reason on their billing page.
          </Alert>
        </div>
      ) : null}

      {!configured ? (
        <div className="mb-4">
          <Alert tone="warning" title="No payout method configured — customers cannot pay you">
            Fill in at least one wallet number or IBAN below. Until then <code>/billing/platform</code> tells the
            customer there is nowhere to send money, and no claim can be submitted.
          </Alert>
        </div>
      ) : (
        <div className="mb-4">
          <Alert tone="info" title="Payouts are being collected into">
            {methods.map((method) => `${method.label}: ${method.number}`).join(" · ")}
            {settings.demo_mode === 1 ? " — demo mode is ON: your own claims approve themselves." : ""}
          </Alert>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Waiting for approval" value={String(pending.length)} hint={`Rs ${Math.round(pendingValue / 100).toLocaleString()} claimed`} />
        <StatCard label="Founding slots used" value={`${granted} / ${settings.founding_member_slots}`} hint={`${slotsLeft} left`} />
        <StatCard
          label="Founding price"
          value={`Rs ${Math.round(settings.founding_member_price_cents / 100).toLocaleString()}`}
          hint={`${settings.founding_member_member_limit} seats each`}
        />
        <StatCard label="Demo mode" value={settings.demo_mode === 1 ? "ON" : "off"} hint="auto-approve your own claims" />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4" /> Where customers send money
          </CardTitle>
          <CardDescription>
            Stored in the database, never in the code. Saving is audited (which methods exist — not the numbers).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PlatformSettingsForm settings={settings} />
          {settings.updated_at ? (
            <p className="mt-3 text-xs text-[hsl(var(--fg-muted))]">
              Last changed {formatDate(settings.updated_at)} ({relativeTime(settings.updated_at)}).
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Claims waiting for you ({pending.length})</CardTitle>
          <CardDescription>
            Check the transaction ID against your own wallet statement before approving. Approval is immediate and
            starts the subscription period from now.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <EmptyState title="Nothing waiting" description="When a customer submits a payment, it appears here with its transaction ID." />
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
                      {claim.payer_note ? <p className="text-sm">“{claim.payer_note}”</p> : null}
                    </div>
                    <div className="flex gap-1">
                      {claim.founding_member === 1 ? <Badge tone="brand">Founding price</Badge> : null}
                      <Badge tone={STATUS_TONE[claim.status] ?? "neutral"}>{claim.status}</Badge>
                    </div>
                  </div>
                  <ReviewClaimForm claimId={claim.id} amountPkr={Math.round(claim.amount_cents / 100)} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Crown className="h-4 w-4" /> Founding Members ({granted})
          </CardTitle>
          <CardDescription>
            Their price is locked in the database and renewals read that lock — changing the plan catalogue later will
            never raise it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {founding.length === 0 ? (
            <EmptyState title="No Founding Members yet" description={`${slotsLeft} of ${settings.founding_member_slots} places are still open. They are granted automatically when a founding-priced claim is approved.`} />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Workspace</TH>
                  <TH>Locked price</TH>
                  <TH>Seats</TH>
                  <TH>Source</TH>
                  <TH>Granted</TH>
                </TR>
              </THead>
              <TBody>
                {founding.map((row) => (
                  <TR key={row.organization_id}>
                    <TD>{row.organization_name}</TD>
                    <TD>Rs {Math.round(row.locked_price_cents / 100).toLocaleString()}/mo</TD>
                    <TD>{row.member_limit}</TD>
                    <TD>
                      <Badge tone={row.source === "auto" ? "brand" : "neutral"}>{row.source}</Badge>
                    </TD>
                    <TD>{relativeTime(row.granted_at)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reviewed claims</CardTitle>
          <CardDescription>Newest first. Self-approved rows are flagged — a one-person platform still keeps an honest trail.</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <EmptyState title="Nothing reviewed yet" description="Approved and rejected claims stay here with their review note." />
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
                {recent.map((claim) => (
                  <TR key={claim.id}>
                    <TD>{claim.organization_name}</TD>
                    <TD>
                      {claim.plan_code} · {claim.billing_cycle}
                    </TD>
                    <TD>Rs {Math.round(claim.amount_cents / 100).toLocaleString()}</TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={STATUS_TONE[claim.status] ?? "neutral"}>{claim.status}</Badge>
                        {claim.self_approved === 1 ? <Badge tone="warning">self-approved</Badge> : null}
                      </div>
                    </TD>
                    <TD className="max-w-[240px] truncate">{claim.review_note ?? "—"}</TD>
                    <TD>{claim.reviewed_at ? relativeTime(claim.reviewed_at) : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
