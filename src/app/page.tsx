import Link from "next/link";
import { ArrowRight, Bot, CheckCircle2, FileText, Workflow, Users, BarChart3 } from "lucide-react";
import { MarketingFooter, MarketingHeader } from "@/components/marketing-shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { listPlans } from "@/lib/plans";
import { formatMoney } from "@/lib/utils";

const features = [
  { icon: Users, title: "Lead CRM", body: "Capture leads from forms, CSV imports or manual entry. Track status from New to Won with full activity history." },
  { icon: Bot, title: "AI lead scoring", body: "Score every lead 0–100 with reasoning and a recommended next action. Rule-based scoring works even without an AI key." },
  { icon: FileText, title: "Proposals", body: "Build priced proposals, share a secure link, and let clients accept or decline. Versioned and downloadable." },
  { icon: Workflow, title: "Automations", body: "Trigger tasks, drafts and approvals when a lead arrives. Duplicate events are blocked by idempotency keys." },
  { icon: BarChart3, title: "Analytics", body: "Conversion rate, pipeline by status, lead sources and proposal acceptance — computed from your real records." },
  { icon: CheckCircle2, title: "Tenant isolation", body: "Every record is scoped to your organisation, enforced server-side and by Postgres row level security." },
] as const;

export default function HomePage() {
  const plans = listPlans();
  return (
    <>
      <MarketingHeader />
      <main>
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto max-w-3xl text-center fade-in">
            <p className="mx-auto mb-4 inline-flex items-center gap-2 rounded-full border border-[hsl(var(--border))] px-3 py-1 text-xs font-medium text-[hsl(var(--fg-muted))]">
              14-day free trial · no card required to explore
            </p>
            <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
              Turn enquiries into paying customers — without hiring an ops team.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-pretty text-base text-[hsl(var(--fg-muted))] sm:text-lg">
              BizPilot AI is one workspace for your leads, proposals and follow-ups. Capture a lead, get an AI score
              with reasoning, send a proposal link, and let automations handle the paperwork.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/signup">
                <Button size="lg">Start free trial <ArrowRight className="h-4 w-4" /></Button>
              </Link>
              <Link href="/pricing">
                <Button size="lg" variant="outline">See pricing</Button>
              </Link>
            </div>
            <p className="mt-4 text-xs text-[hsl(var(--fg-muted))]">
              No fabricated testimonials or customer counts on this page — only what the product actually does.
            </p>
          </div>

          <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Card key={f.title}>
                <CardHeader>
                  <f.icon className="h-5 w-5 text-brand-600" />
                  <CardTitle>{f.title}</CardTitle>
                  <CardDescription>{f.body}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        <section className="border-y border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 py-16">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-2xl font-bold tracking-tight">Plans that scale with the pipeline</h2>
            <p className="mt-2 text-sm text-[hsl(var(--fg-muted))]">Prices are stored in the database and editable from the admin panel — no code changes needed.</p>
            <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {plans.map((p) => (
                <Card key={p.code} className={p.code === "professional" ? "ring-2 ring-brand-500" : ""}>
                  <CardHeader>
                    <CardTitle>{p.name}</CardTitle>
                    <p className="text-2xl font-bold">{formatMoney(p.price_monthly_cents)}<span className="text-sm font-normal text-[hsl(var(--fg-muted))]">/mo</span></p>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm text-[hsl(var(--fg-muted))]">
                    <p>{p.lead_limit.toLocaleString()} leads</p>
                    <p>{p.member_limit} team member{p.member_limit === 1 ? "" : "s"}</p>
                    <p>{p.ai_generation_limit.toLocaleString()} AI generations / month</p>
                    <p>{p.automation_limit > 0 ? `${p.automation_limit} automations` : "Automations not included"}</p>
                    <Link href="/signup" className="mt-3 inline-block">
                      <Button size="sm" variant={p.code === "professional" ? "default" : "outline"}>Choose {p.name}</Button>
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="mt-6">
              <Alert tone="info" title="Payments need configuration">
                Stripe is not configured in this deployment yet. Until <code>STRIPE_SECRET_KEY</code> and price IDs are set,
                checkout is disabled and accounts run on the Starter feature set. Nothing pretends a payment succeeded.
              </Alert>
            </div>
          </div>
        </section>
      </main>
      <MarketingFooter />
    </>
  );
}
