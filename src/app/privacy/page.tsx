import type { Metadata } from "next";
import { MarketingFooter, MarketingHeader } from "@/components/marketing-shell";

export const metadata: Metadata = { title: "Privacy policy" };

const sections = [
  ["Data we store", "Account details (name, email, hashed password), workspace details, and the business records you create: leads, customers, proposals, documents, messages, tasks and activity logs. Files you upload are stored either on the application server or in your connected Dropbox account."],
  ["How we use it", "To operate the product: authenticating you, enforcing plan limits, generating AI drafts you request, sending email you approve, and producing analytics for your own workspace. We do not sell data and we do not use your records to train models."],
  ["Third parties", "Stripe (payments), your chosen AI provider (only the text you send for generation), Resend (email delivery) and Dropbox (file storage) when configured by the operator of this deployment. Each receives only the minimum data needed for its function."],
  ["Retention", "Records stay until you delete them or the operator of this deployment removes them. Password reset tokens expire after 24 hours; sessions expire after 30 days; rate-limit counters expire automatically."],
  ["Your rights", "You can export your leads as CSV at any time and delete leads, customers, proposals and documents from the interface. For a full export or account deletion, contact the operator of this deployment."],
  ["Security", "Passwords are hashed with scrypt and per-user salts. Sessions use HttpOnly, SameSite cookies. Every database query is scoped to your organisation, and the production Postgres schema enables row level security."],
  ["Cookies", "One session cookie is required to stay signed in, plus a local preference for light/dark theme. No advertising or tracking cookies are set."],
  ["Contact", "Privacy questions go to the operator of this deployment; the contact address is the one configured in EMAIL_FROM."],
];

export default function PrivacyPage() {
  return (
    <>
      <MarketingHeader />
      <main className="mx-auto max-w-3xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Privacy policy</h1>
        <p className="mt-2 text-sm text-[hsl(var(--fg-muted))]">Last updated: 9 August 2026</p>
        <p className="mt-4 text-sm text-[hsl(var(--fg-muted))]">
          This is a working policy for the software, not legal advice. Review it with a qualified professional before
          selling the product commercially.
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
