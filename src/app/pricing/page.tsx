import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "@/components/marketing-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listPlans, isStripeDeploymentReady } from "@/lib/plans-server";
import { formatMoney } from "@/lib/utils";

export const metadata: Metadata = { title: "Pricing" };

export default function PricingPage() {
  const plans = listPlans();
  const stripeReady = isStripeDeploymentReady();

  return (
    <>
      <MarketingHeader />
      <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Simple, transparent pricing</h1>
        <p className="mt-2 max-w-2xl text-[hsl(var(--fg-muted))]">
          Prices and limits are read from the database, so an administrator can change them without a deploy.
          {!stripeReady && " Payments are not configured in this environment yet — see the README."}
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((p) => (
            <Card key={p.code} className={p.code === "professional" ? "ring-2 ring-brand-500" : ""}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle>{p.name}</CardTitle>
                  {p.code === "professional" ? <Badge tone="brand">Popular</Badge> : null}
                </div>
                <p className="text-3xl font-bold">{formatMoney(p.price_monthly_cents)}<span className="text-sm font-normal text-[hsl(var(--fg-muted))]">/month</span></p>
                <p className="text-xs text-[hsl(var(--fg-muted))]">or {formatMoney(p.price_annual_cents)} per year</p>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="Leads" value={p.lead_limit.toLocaleString()} />
                <Row label="Team members" value={String(p.member_limit)} />
                <Row label="AI generations / mo" value={p.ai_generation_limit.toLocaleString()} />
                <Row label="Automations" value={p.automation_limit > 0 ? String(p.automation_limit) : "—"} />
                <Row label="Documents" value={p.document_limit.toLocaleString()} />
                <Row label="Analytics" value={String(p.featuresParsed.analytics ?? "basic")} />
                <Link href="/signup" className="mt-3 block">
                  <Button className="w-full" variant={p.code === "professional" ? "default" : "outline"}>Start trial</Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-10 overflow-x-auto rounded-xl border border-[hsl(var(--border))]">
          <table className="w-full text-sm">
            <thead className="bg-[hsl(var(--muted))]">
              <tr>
                <th className="p-3 text-left font-semibold">Capability</th>
                {plans.map((p) => <th key={p.code} className="p-3 text-left font-semibold">{p.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {[
                ["CRM", (f: Record<string, unknown>) => (f.crm ? "Yes" : "—")],
                ["Proposals", (f: Record<string, unknown>) => (f.proposals ? "Yes" : "—")],
                ["AI sales assistant", (f: Record<string, unknown>) => (f.ai_assistant ? "Yes" : "—")],
                ["Automation workflows", (f: Record<string, unknown>) => (f.automations ? "Yes" : "—")],
                ["Document storage", (f: Record<string, unknown>) => (f.documents ? "Yes" : "—")],
                ["Multiple workspaces", (f: Record<string, unknown>) => (f.multi_workspace ? "Yes" : "—")],
              ].map(([label, fn]) => (
                <tr key={label as string} className="border-t border-[hsl(var(--border))]">
                  <td className="p-3 font-medium">{label as string}</td>
                  {plans.map((p) => (
                    <td key={p.code} className="p-3 text-[hsl(var(--fg-muted))]">
                      {(fn as (f: Record<string, unknown>) => string)(p.featuresParsed as Record<string, unknown>)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[hsl(var(--fg-muted))]">{label}</span>
      <span className="font-medium capitalize">{value}</span>
    </div>
  );
}
