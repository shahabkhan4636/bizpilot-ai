import type { Metadata } from "next";
import { MarketingFooter, MarketingHeader } from "@/components/marketing-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Features" };

const groups = [
  {
    title: "CRM & pipeline",
    items: [
      "Manual lead creation and public capture form",
      "CSV import with header detection and per-row validation",
      "CSV export of any filtered view",
      "Search, filter and sort across all leads",
      "Seven pipeline statuses with activity history",
      "Notes, follow-up reminders and assignment",
    ],
  },
  {
    title: "AI assistance",
    items: [
      "Lead scoring 0–100 with written reasoning",
      "Recommended next action and communication approach",
      "Nine content types: emails, follow-ups, replies, proposals, quotes and more",
      "Tone, language, objective and pricing controls",
      "Graceful 'AI not configured' state — never fake output",
    ],
  },
  {
    title: "Proposals",
    items: [
      "Line items with quantity, unit price and totals",
      "Secure public share link",
      "Client accept / decline recorded on the proposal",
      "Version increments on every edit",
      "Print-ready layout for PDF export",
    ],
  },
  {
    title: "Automations",
    items: [
      "Eight triggers including lead created and proposal accepted",
      "Seven actions including task creation and AI drafts",
      "Conditional logic on any field",
      "Per-automation daily run limits",
      "Idempotency keys block duplicate executions",
      "Full execution log with errors and retry counts",
    ],
  },
  {
    title: "Security & compliance",
    items: [
      "Scrypt password hashing with per-user salts",
      "HttpOnly, SameSite session cookies",
      "Server-side role checks on every mutation",
      "Tenant scoping on every query",
      "Audit log of privileged actions",
      "Rate limiting on auth and AI endpoints",
    ],
  },
  {
    title: "Operations",
    items: [
      "Usage metering per organisation",
      "Plan limits enforced server-side",
      "Admin panel for plans, users and health",
      "Webhook events table with dedupe",
      "CSV analytics export",
    ],
  },
];

export default function FeaturesPage() {
  return (
    <>
      <MarketingHeader />
      <main className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Everything included, nothing mocked</h1>
        <p className="mt-2 max-w-2xl text-[hsl(var(--fg-muted))]">
          Every item below is implemented in the codebase. Integrations that require credentials clearly report their
          status instead of pretending to work.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {groups.map((g) => (
            <Card key={g.title}>
              <CardHeader>
                <CardTitle>{g.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription>
                  <ul className="list-disc space-y-1.5 pl-4">
                    {g.items.map((i) => <li key={i}>{i}</li>)}
                  </ul>
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}
