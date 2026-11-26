import type { Metadata } from "next";
import Link from "next/link";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { CheckoutButton, PortalButton, CancelForm } from "@/components/billing/billing-forms";
import { listPlans } from "@/lib/plans";
import { all } from "@/lib/db";
import { isStripeConfigured, stripePriceId } from "@/lib/stripe";
import { formatMoney, formatDate, relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Billing", robots: { index: false } };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const ctx = await loadAppContext();
  const sp = await searchParams;
  const plans = listPlans();
  const stripeReady = isStripeConfigured();

  const events = all<{ id: string; event_type: string; created_at: string; processed_at: string | null; error: string | null }>(
    "select id, event_type, created_at, processed_at, error from webhook_events where provider = 'stripe' order by created_at desc limit 20"
  );

  // Invoices are reconstructed from webhook payloads that arrived with a verified
  // signature. Nothing here is invented: if Stripe never sent an invoice event,
  // the table stays empty.
  const invoiceEvents = all<{ external_id: string; event_type: string; payload: string; created_at: string }>(
    `select external_id, event_type, payload, created_at from webhook_events
      where provider = 'stripe' and event_type in ('invoice.paid','invoice.payment_failed','invoice.payment_succeeded')
      order by created_at desc limit 24`
  );

  type InvoiceRow = {
    id: string;
    number: string;
    amount: number;
    currency: string;
    status: string;
    paid: boolean;
    url: string | null;
    period: string;
    received: string;
  };

  const invoices: InvoiceRow[] = [];
  for (const ev of invoiceEvents) {
    try {
      const parsed = JSON.parse(ev.payload) as { data?: { object?: Record<string, unknown> } };
      const o = parsed?.data?.object ?? {};
      const amount = typeof o.amount_paid === "number" ? o.amount_paid : typeof o.amount_due === "number" ? o.amount_due : null;
      if (amount === null) continue;
      const created = typeof o.created === "number" ? new Date(o.created * 1000).toISOString() : ev.created_at;
      invoices.push({
        id: String(o.id ?? ev.external_id),
        number: typeof o.number === "string" && o.number ? o.number : String(o.id ?? "—"),
        amount,
        currency: String(o.currency ?? "usd").toUpperCase(),
        status: String(o.status ?? (ev.event_type === "invoice.paid" ? "paid" : "failed")),
        paid: ev.event_type !== "invoice.payment_failed" && (o.status === "paid" || ev.event_type === "invoice.paid"),
        url: typeof o.hosted_invoice_url === "string" ? o.hosted_invoice_url : null,
        period: created,
        received: ev.created_at,
      });
    } catch {
      // A stored payload we cannot parse simply does not produce an invoice row.
    }
  }

  const sub = ctx.subscription;
  const cycle = sub?.billing_cycle === "annual" ? "annual" : "monthly";
  const priceId = stripePriceId(ctx.plan.code, cycle);

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      planName={ctx.plan.name}
      trialDaysLeft={ctx.trialDaysLeft}
    >
      <PageHeader title="Billing" description="Plans, usage and invoices. Plan changes go through Stripe Checkout; entitlements only move on a verified webhook." />

      {sp.checkout === "returned" ? (
        <div className="mb-4">
          <Alert tone="info" title="Returned from Stripe">
            Your payment may still be processing. This page will show the new plan only after Stripe&apos;s webhook has been
            verified — a success page never grants access by itself.
          </Alert>
        </div>
      ) : null}
      {sp.checkout === "cancelled" ? (
        <div className="mb-4"><Alert tone="warning" title="Checkout cancelled">No charge was made and nothing changed.</Alert></div>
      ) : null}
      {!stripeReady ? (
        <div className="mb-4">
          <Alert tone="warning" title="Stripe is not configured">
            Checkout and the billing portal are disabled because <code>STRIPE_SECRET_KEY</code> is missing. The workspace
            runs on {ctx.plan.name} limits. See the README for the required keys and webhook setup.
          </Alert>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Current plan" value={ctx.plan.name} hint={sub ? `${sub.status}${sub.cancel_at_period_end ? " · cancels at period end" : ""}` : "no subscription row"} />
        <StatCard label="Billing cycle" value={cycle} hint={priceId ? `price ${priceId.slice(0, 14)}…` : "no price ID configured"} />
        <StatCard label="Leads used" value={`${ctx.usage.leads} / ${ctx.plan.lead_limit.toLocaleString()}`} tone={ctx.usage.leads >= ctx.plan.lead_limit ? "warn" : "default"} />
        <StatCard label="AI used" value={`${ctx.usage.aiThisMonth} / ${ctx.plan.ai_generation_limit.toLocaleString()}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>Invoices &amp; receipts</CardTitle>
              <CardDescription>
                Built only from signature-verified Stripe invoice events stored by the webhook endpoint. Amounts are shown
                exactly as Stripe reported them.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {invoices.length === 0 ? (
                <EmptyState
                  title="No invoices recorded"
                  description={
                    stripeReady
                      ? "Invoice events appear here after Stripe sends invoice.paid or invoice.payment_failed to the webhook endpoint."
                      : "Stripe is not configured in this environment, so no invoice can exist yet."
                  }
                />
              ) : (
                <Table>
                  <THead>
                    <TR><TH>Invoice</TH><TH>Date</TH><TH>Amount</TH><TH>Status</TH><TH>Receipt</TH></TR>
                  </THead>
                  <TBody>
                    {invoices.map((inv) => (
                      <TR key={`${inv.id}-${inv.received}`}>
                        <TD className="font-mono text-xs">{inv.number}</TD>
                        <TD>{formatDate(inv.period)}</TD>
                        <TD>{formatMoney(inv.amount, inv.currency.toLowerCase())}</TD>
                        <TD>
                          <Badge tone={inv.paid ? "success" : "warning"}>{inv.status}</Badge>
                        </TD>
                        <TD>
                          {inv.url ? (
                            <a className="text-brand-700 underline" href={inv.url} rel="noreferrer noopener" target="_blank">Open</a>
                          ) : (
                            <span className="text-xs text-[hsl(var(--fg-muted))]">—</span>
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Plans</CardTitle>
              <CardDescription>Prices come from the database and can be edited in the admin panel.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {plans.map((p) => {
                const current = p.code === ctx.plan.code;
                return (
                  <div key={p.code} className={`rounded-xl border p-4 ${current ? "border-brand-500 ring-1 ring-brand-500" : "border-[hsl(var(--border))]"}`}>
                    <div className="flex items-center justify-between">
                      <p className="font-semibold">{p.name}</p>
                      {current ? <Badge tone="brand">current</Badge> : null}
                    </div>
                    <p className="mt-1 text-xl font-bold">{formatMoney(p.price_monthly_cents)}<span className="text-xs font-normal text-[hsl(var(--fg-muted))]">/mo</span></p>
                    <p className="text-xs text-[hsl(var(--fg-muted))]">{formatMoney(p.price_annual_cents)}/yr · {p.lead_limit.toLocaleString()} leads · {p.member_limit} member(s)</p>
                    <div className="mt-3 space-y-2">
                      <CheckoutButton
                        planCode={p.code}
                        cycle="monthly"
                        label={current ? "Switch to monthly billing" : `Choose ${p.name}`}
                      />
                      <CheckoutButton planCode={p.code} cycle="annual" label="Buy annual (10 months)" />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Payment events</CardTitle>
              <CardDescription>Raw Stripe webhook deliveries recorded for this deployment.</CardDescription>
            </CardHeader>
            {events.length === 0 ? (
              <EmptyState title="No Stripe events yet" description="Once the webhook endpoint is configured and a subscription event arrives, it appears here with its verification result." />
            ) : (
              <Table>
                <THead><TR><TH>Event</TH><TH>Received</TH><TH>Processed</TH><TH>Error</TH></TR></THead>
                <TBody>
                  {events.map((e) => (
                    <TR key={e.id}>
                      <TD className="font-mono text-xs">{e.event_type}</TD>
                      <TD className="text-[hsl(var(--fg-muted))]">{relativeTime(e.created_at)}</TD>
                      <TD>{e.processed_at ? <Badge tone="success">yes</Badge> : <Badge tone="neutral">no</Badge>}</TD>
                      <TD className="max-w-[220px] truncate text-xs text-red-600">{e.error ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Subscription</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Plan" value={ctx.plan.name} />
              <Row label="Status" value={sub?.status ?? "none"} />
              <Row label="Cycle" value={cycle} />
              <Row label="Period ends" value={sub?.current_period_end ? formatDate(sub.current_period_end) : "—"} />
              <Row label="Trial ends" value={sub?.trial_ends_at ? formatDate(sub.trial_ends_at) : "—"} />
              <Row label="Stripe customer" value={sub && "stripe_customer_id" in sub ? String((sub as unknown as { stripe_customer_id?: string }).stripe_customer_id ?? "—") : "—"} />
              <div className="pt-2"><PortalButton disabled={!stripeReady} /></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Cancel</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <CancelForm />
              <p className="text-xs text-[hsl(var(--fg-muted))]">
                Prefer the <Link href="/settings" className="underline">settings page</Link> for workspace-level changes.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[hsl(var(--fg-muted))]">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </div>
  );
}
