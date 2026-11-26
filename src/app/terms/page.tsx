import type { Metadata } from "next";
import { MarketingFooter, MarketingHeader } from "@/components/marketing-shell";

export const metadata: Metadata = { title: "Terms of service" };

const sections = [
  ["The service", "BizPilot AI is business software for managing leads, customers, proposals and related communication. This deployment is operated by whoever installed it, not by a central provider."],
  ["Accounts", "You must supply accurate details and keep your password secure. You are responsible for activity under your account. Do not share one login between people — invite them as members instead."],
  ["Subscriptions and billing", "Paid plans are billed through Stripe on the cycle you choose. Plan changes take effect only after Stripe confirms them by webhook. Cancelling stops future billing at the end of the current period; it does not retroactively refund."],
  ["Acceptable use", "Do not use the product to send unsolicited bulk email, to store unlawful material, or to attempt to access another organisation's data. Automated sending requires human approval in this product by design — do not attempt to bypass it."],
  ["AI output", "AI-generated content can be wrong. You are responsible for reviewing anything before it is sent to a customer. The product requires explicit approval before external sending for this reason."],
  ["Availability", "The software is provided as-is. There is no uptime guarantee unless the operator offers one separately in writing."],
  ["Liability", "To the maximum extent permitted by law, the operator is not liable for indirect or consequential losses, including lost profits or lost data. Keep your own backups."],
  ["Changes", "These terms may change as the product develops. Continued use after a change means you accept the updated terms."],
];

export default function TermsPage() {
  return (
    <>
      <MarketingHeader />
      <main className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Terms of service</h1>
        <p className="mt-2 text-sm text-[hsl(var(--fg-muted))]">Last updated: 9 August 2026</p>
        <p className="mt-4 text-sm text-[hsl(var(--fg-muted))]">
          Template terms for the software. Have them reviewed before commercial launch.
        </p>
        <div className="mt-8 space-y-6">
          {sections.map(([title, body]) => (
            <section key={title}>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="mt-1 text-sm text-[hsl(var(--fg-muted))]">{body}</p>
            </section>
          ))}
        </div>
      </main>
      <MarketingFooter />
    </>
  );
}
