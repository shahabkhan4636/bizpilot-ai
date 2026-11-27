import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Copy, Crown, Info } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { SubmitPlatformClaimForm } from "@/components/admin/platform-payment-forms";
import {
  foundingForOrg,
  getPlatformSettings,
  listClaimsForOrg,
  openClaimForOrg,
  quoteForClaim,
} from "@/lib/platform-payments-server";
import { isPlatformConfigured, methodLabel, platformMethods } from "@/lib/platform-payments";
import { listPlans } from "@/lib/plans";
import { formatDate, relativeTime } from "@/lib/utils";

/**
 * /billing/platform — the customer pays *BizPilot*.
 *
 * Separate page from `/billing/local` on purpose: that one configures how the
 * customer's own clients pay them. Merging the two is how a product ends up
 * displaying the platform owner's wallet on a customer's payout settings.
 *
 * The amount shown here is a preview only; the server recomputes it on submit.
 */

export const metadata: Metadata = { title: "Pay BizPilot", robots: { index: false } };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "warning" | "success" | "danger" | "neutral"> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export default async function PlatformBillingPage() {
  const ctx = await loadAppContext();
  const canManage = ctx.can("billing:manage");

  const settings = getPlatformSettings();
  const methods = platformMethods(settings);
  const configured = isPlatformConfigured(settings);
  const member = foundingForOrg(ctx.orgId);
  const openClaim = openClaimForOrg(ctx.orgId);
  const claims = listClaimsForOrg(ctx.orgId, 10);

  // Amounts come from the same function the server uses on submit, so the preview
  // and the stored claim can never disagree — including a locked Founding price.
  const plans = listPlans().map((plan) => ({
    code: plan.code,
    name: plan.name,
    monthlyPkr: Math.round((quoteForClaim(ctx.orgId, plan.code, "monthly")?.amountCents ?? 0) / 100),
    annualPkr: Math.round((quoteForClaim(ctx.orgId, plan.code, "annual")?.amountCents ?? 0) / 100),
  }));

  // Show the customer exactly what the server will ask for the first plan, so the
  // preview and the stored claim can never disagree in front of them.
  const previewPlan = plans[0]?.code ?? "starter";
  const preview = quoteForClaim(ctx.orgId, previewPlan, "monthly");

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
      <Link href="/billing" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Billing
      </Link>

      <PageHeader
        title="Pay BizPilot"
        description="Send the exact amount to one of the numbers below, then submit the transaction ID. Nothing activates until the payment is confirmed."
      />

      {member ? (
        <div className="mb-4">
          <Alert tone="success" title="Founding Member — your price is locked">
            Rs {Math.round(member.locked_price_cents / 100).toLocaleString()}/month for as long as you stay subscribed,
            with {member.member_limit} seats. Renewals always use this locked price, even if the public price rises.
          </Alert>
        </div>
      ) : preview && preview.slotsLeft > 0 ? (
        <div className="mb-4">
          <Alert tone="info" title={`Founding Member places open: ${preview.slotsLeft} left`}>
            At Rs {Math.round(settings.founding_member_price_cents / 100).toLocaleString()}/month with{" "}
            {settings.founding_member_member_limit} seats, granted when your first payment is approved. The price is
            locked for as long as you stay subscribed.
          </Alert>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Where to send money</CardTitle>
            <CardDescription>
              {configured ? "These are the platform owner's account details." : "The platform owner has not configured payouts yet."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!configured ? (
              <Alert tone="warning" title="Nowhere to send money yet">
                No wallet number or IBAN has been configured, so a claim cannot be submitted. If you are the platform
                owner, add one on <Link href="/admin/platform-payments" className="underline">platform payments</Link>.
              </Alert>
            ) : (
              <div className="space-y-3">
                <Table>
                  <THead>
                    <TR>
                      <TH>Method</TH>
                      <TH>Number / IBAN</TH>
                      <TH>Account title</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {methods.map((method) => (
                      <TR key={method.kind}>
                        <TD>
                          <Badge tone={method.kind === settings.default_method ? "brand" : "neutral"}>
                            {method.label}
                            {method.kind === settings.default_method ? " · preferred" : ""}
                          </Badge>
                          {method.bankName ? <span className="ml-2 text-xs text-[hsl(var(--fg-muted))]">{method.bankName}</span> : null}
                        </TD>
                        <TD>
                          <code className="select-all">{method.number}</code>
                        </TD>
                        <TD>{method.accountTitle ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                {settings.instructions ? (
                  <Alert tone="info" title="Instructions from the owner">
                    {settings.instructions}
                  </Alert>
                ) : null}
                <p className="flex items-start gap-2 text-xs text-[hsl(var(--fg-muted))]">
                  <Copy className="mt-0.5 h-3.5 w-3.5" /> Send the exact amount. A different amount needs manual review and
                  may be rejected.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Crown className="h-4 w-4" /> Submit your payment
            </CardTitle>
            <CardDescription>
              {canManage
                ? "Enter the transaction ID from your wallet receipt so the owner can match it."
                : "Only a workspace owner or admin can submit a payment."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {openClaim ? (
              <div className="space-y-3">
                <Alert tone="warning" title="A payment is already waiting for approval">
                  {openClaim.reference} · Rs {Math.round(openClaim.amount_cents / 100).toLocaleString()} · submitted{" "}
                  {relativeTime(openClaim.submitted_at)}. You cannot submit another until this one is reviewed.
                </Alert>
                <p className="text-sm text-[hsl(var(--fg-muted))]">
                  If the transaction ID was wrong, ask the platform owner to reject it, then submit again.
                </p>
              </div>
            ) : canManage ? (
              <SubmitPlatformClaimForm
                plans={plans}
                defaultMethod={settings.default_method}
                methods={methods.map((method) => ({ kind: method.kind, label: method.label }))}
                openClaimPlan={previewPlan}
              />
            ) : (
              <EmptyState title="No permission" description="Ask your workspace owner to submit the platform payment." />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your platform payment history</CardTitle>
          <CardDescription>
            Approved claims start the subscription from the approval time. Rejected claims show the owner&apos;s reason.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {claims.length === 0 ? (
            <EmptyState title="No payments yet" description="Once you submit a transaction ID it is listed here with its status." />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Submitted</TH>
                  <TH>Plan</TH>
                  <TH>Amount</TH>
                  <TH>Reference</TH>
                  <TH>Status</TH>
                  <TH>Note</TH>
                </TR>
              </THead>
              <TBody>
                {claims.map((claim) => (
                  <TR key={claim.id}>
                    <TD>{formatDate(claim.submitted_at)}</TD>
                    <TD>
                      {claim.plan_code} · {claim.billing_cycle}
                    </TD>
                    <TD>Rs {Math.round(claim.amount_cents / 100).toLocaleString()}</TD>
                    <TD>
                      <code>{claim.reference}</code>
                    </TD>
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={STATUS_TONE[claim.status] ?? "neutral"}>{claim.status}</Badge>
                        {claim.founding_member === 1 ? <Badge tone="brand">founding price</Badge> : null}
                      </div>
                    </TD>
                    <TD className="max-w-[220px] truncate">{claim.review_note ?? "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 flex items-start gap-2 text-xs text-[hsl(var(--fg-muted))]">
        <Info className="mt-0.5 h-3.5 w-3.5" /> This page is for paying the BizPilot platform. To configure how{" "}
        <em>your own</em> customers pay you, use{" "}
        <Link href="/billing/local" className="underline">local payments</Link>.
        {methods.length > 0 ? ` Methods: ${methods.map((method) => methodLabel(method.kind)).join(", ")}.` : ""}
      </p>
    </AppShell>
  );
}
