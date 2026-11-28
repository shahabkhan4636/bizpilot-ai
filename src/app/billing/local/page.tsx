import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Copy } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  LocalMethodForm,
  SubmitPaymentForm,
  ReviewPaymentButtons,
  ToggleMethodButton,
  DeleteMethodButton,
  RefundPaymentForm,
} from "@/components/billing/local-payment-forms";
import { listLocalPaymentData } from "@/lib/actions/local-payments";
import { providerStatuses } from "@/lib/payments/registry";
import { listPlans } from "@/lib/plans";
import { formatDate } from "@/lib/utils";
import {
  LOCAL_METHOD_LABEL,
  paymentReference,
  pkrPerUsd,
  toPkrRupees,
  type LocalMethodKind,
} from "@/lib/local-payments";

export const metadata: Metadata = { title: "Local payments", robots: { index: false } };

const STATUS_TONE: Record<string, "brand" | "neutral" | "success" | "warning" | "danger"> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  cancelled: "neutral",
};

export default async function LocalPaymentsPage() {
  const ctx = await loadAppContext();
  const { methods, requests, refunds } = await listLocalPaymentData(ctx.orgId);
  const gateways = providerStatuses();
  const plans = listPlans();
  const canManage = ctx.can("billing:manage");
  const canConfigure = ctx.can("settings:workspace");
  const activeMethods = methods.filter((m) => m.is_active === 1);

  // Suggested rupees per plan, from the real USD catalogue and the configured rate.
  const rate = pkrPerUsd();
  const amounts: Record<string, { monthly: number; annual: number }> = {};
  for (const p of plans) {
    amounts[p.code] = {
      monthly: toPkrRupees(p.price_monthly_cents, rate),
      annual: toPkrRupees(p.price_annual_cents, rate),
    };
  }

  const pending = requests.filter((r) => r.status === "pending");
  const refundedByRequest = new Map<string, number>();
  for (const refund of refunds) {
    refundedByRequest.set(refund.request_id, (refundedByRequest.get(refund.request_id) ?? 0) + refund.amount_cents);
  }
  const reference = paymentReference(ctx.membership.organization_slug ?? "workspace");

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
      <Link href="/billing" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Billing
      </Link>

      <PageHeader
        title="Local payments"
        description="SadaPay, JazzCash, EasyPaisa and bank transfer. The customer pays you directly; the plan activates when the payment is approved."
      />

      <div className="mb-4">
        <Alert tone="info" title="How this works, honestly">
          There is no gateway in this flow. You receive the money in your own wallet or bank account, then
          someone with billing rights approves the claim below — that approval is what activates the plan, and it
          is recorded in the audit log with the amount and reference. Card payments still go through Stripe when
          it is configured. Rate used for suggestions: <strong>1 USD = {rate} PKR</strong> (set <code>PKR_PER_USD</code> to change it).
        </Alert>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {activeMethods.length === 0 ? (
            <Card>
              <CardHeader><CardTitle>Send the payment</CardTitle></CardHeader>
              <EmptyState
                title="No payout account yet"
                description={
                  canConfigure
                    ? "Add your SadaPay / JazzCash / EasyPaisa / bank details on the right. Once saved, customers can pay into it."
                    : "An owner or admin has to add a payout account before payments can be submitted."
                }
              />
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Send the payment</CardTitle>
                <CardDescription>
                  Transfer to one of the accounts, then submit the transaction ID. Put{" "}
                  <strong>{reference}</strong> in the transfer note so it can be matched.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-2">
                  {activeMethods.map((m) => (
                    <div key={m.id} className="rounded-lg border border-[hsl(var(--border))] p-3 text-sm">
                      <p className="font-medium">
                        {m.label || LOCAL_METHOD_LABEL[(m.kind as LocalMethodKind) ?? "other"]}
                      </p>
                      <p className="font-mono text-xs">{m.account_number}</p>
                      <p className="text-xs text-[hsl(var(--fg-muted))]">{m.account_title}</p>
                      {m.payment_link ? (
                        <a href={m.payment_link} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-brand-600 underline">
                          Open payment link
                        </a>
                      ) : null}
                      {m.instructions ? <p className="mt-1 text-xs">{m.instructions}</p> : null}
                    </div>
                  ))}
                </div>
                {canManage ? (
                  <SubmitPaymentForm methods={activeMethods} plans={plans.map((p) => ({ code: p.code, name: p.name }))} amounts={amounts} />
                ) : (
                  <Alert tone="info">Your role can see this page but not submit payments — ask an owner or admin.</Alert>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
            {requests.length === 0 ? (
              <EmptyState title="No payments yet" description="Submitted payments and their approval state will appear here." />
            ) : (
              <Table>
                <THead><TR><TH>Submitted</TH><TH>Plan</TH><TH className="text-right">Amount</TH><TH>Reference</TH><TH>Status</TH><TH /></TR></THead>
                <TBody>
                  {requests.map((r) => (
                    <TR key={r.id}>
                      <TD className="text-[hsl(var(--fg-muted))]">{formatDate(r.submitted_at)}</TD>
                      <TD>{r.plan_code} <span className="text-xs text-[hsl(var(--fg-muted))]">({r.billing_cycle})</span></TD>
                      <TD className="text-right tabular-nums">Rs {(r.amount_cents / 100).toLocaleString()}</TD>
                      <TD className="font-mono text-xs">{r.reference ?? "—"}</TD>
                      <TD>
                        <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
                        {r.review_note ? <p className="mt-1 text-xs text-[hsl(var(--fg-muted))]">{r.review_note}</p> : null}
                      </TD>
                      <TD className="space-y-2">
                        {r.status === "pending" && canManage ? <ReviewPaymentButtons requestId={r.id} /> : null}
                        {r.gateway_provider ? (
                          <p className="font-mono text-[11px] text-[hsl(var(--fg-muted))]">
                            via {r.gateway_provider}:{r.gateway_payment_id}
                          </p>
                        ) : null}
                        {r.status === "approved" && canManage && r.amount_cents - (refundedByRequest.get(r.id) ?? 0) > 0 ? (
                          <RefundPaymentForm
                            requestId={r.id}
                            paidPkr={Math.round(r.amount_cents / 100)}
                            remainingPkr={Math.round((r.amount_cents - (refundedByRequest.get(r.id) ?? 0)) / 100)}
                          />
                        ) : null}
                        {refundedByRequest.has(r.id) ? (
                          <Badge tone="warning">
                            refunded Rs {((refundedByRequest.get(r.id) ?? 0) / 100).toLocaleString()}
                          </Badge>
                        ) : null}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          {refunds.length > 0 ? (
            <Card className="overflow-hidden">
              <CardHeader><CardTitle>Refunds</CardTitle></CardHeader>
              <Table>
                <THead><TR><TH>When</TH><TH>Payment</TH><TH className="text-right">Amount</TH><TH>Reason</TH></TR></THead>
                <TBody>
                  {refunds.map((rf) => (
                    <TR key={rf.id}>
                      <TD className="text-[hsl(var(--fg-muted))]">{formatDate(rf.created_at)}</TD>
                      <TD className="font-mono text-xs">{rf.request_id.slice(0, 8)}</TD>
                      <TD className="text-right tabular-nums">Rs {(rf.amount_cents / 100).toLocaleString()}</TD>
                      <TD className="text-[hsl(var(--fg-muted))]">{rf.reason ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          ) : null}

          {pending.length > 0 && canManage ? (
            <Alert tone="warning" title={`${pending.length} payment(s) waiting for approval`}>
              Approving activates the plan immediately. Only approve once the money is actually in your account —
              the audit log records that you did.
            </Alert>
          ) : null}
        </div>

        <div className="space-y-4">
          {canConfigure ? (
            <Card>
              <CardHeader>
                <CardTitle>Your payout accounts</CardTitle>
                <CardDescription>Where customers send money. Only your workspace can see these.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <LocalMethodForm />
                {methods.length > 0 ? (
                  <div className="space-y-2 border-t border-[hsl(var(--border))] pt-3">
                    {methods.map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 text-sm">
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {m.label || LOCAL_METHOD_LABEL[(m.kind as LocalMethodKind) ?? "other"]}
                            {m.is_active ? null : <Badge tone="neutral">disabled</Badge>}
                          </p>
                          <p className="truncate font-mono text-xs">{m.account_number}</p>
                        </div>
                        <div className="flex shrink-0 items-center">
                          <ToggleMethodButton method={m} />
                          <DeleteMethodButton method={m} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Automatic verification</CardTitle>
              <CardDescription>
                With a merchant account, a signed webhook approves the payment for you. Until then this stays off.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {gateways.map((g) => (
                <div key={g.name} className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{g.name}</span>
                  {g.configured ? (
                    <Badge tone="success">webhooks live</Badge>
                  ) : (
                    <span className="text-xs text-[hsl(var(--fg-muted))]">
                      needs {g.requiredEnv.join(", ")}
                    </span>
                  )}
                </div>
              ))}
              <p className="text-xs text-[hsl(var(--fg-muted))]">
                Webhook URL: <code>/api/payments/webhook/&lt;provider&gt;</code> — signature checked against the raw
                body, every payment id stored once, and an amount that does not match the claim is never approved
                automatically.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Charging in rupees</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-[hsl(var(--fg-muted))]">
              <p>
                The plan catalogue is priced in USD, so Pakistani customers are quoted at{" "}
                <strong>1 USD = {rate} PKR</strong>. Set <code>PKR_PER_USD</code> in your environment to the rate you
                actually want to charge.
              </p>
              <ul className="space-y-1">
                {plans.map((p) => (
                  <li key={p.code}>
                    {p.name}: <strong>Rs {amounts[p.code]!.monthly.toLocaleString()}</strong>/mo ·{" "}
                    Rs {amounts[p.code]!.annual.toLocaleString()}/yr
                  </li>
                ))}
              </ul>
              <p className="flex items-center gap-1 text-xs">
                <Copy className="h-3 w-3" /> Transfer note: <span className="font-mono">{reference}</span>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
