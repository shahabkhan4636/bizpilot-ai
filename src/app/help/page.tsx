import type { Metadata } from "next";
import Link from "next/link";
import { MarketingFooter, MarketingHeader } from "@/components/marketing-shell";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Help & setup" };

const faqs = [
  {
    q: "How do I capture leads from my website?",
    a: "POST to /api/leads/capture with the header x-capture-key (the deployment's LEAD_CAPTURE_KEY) and x-org-slug (your workspace slug), or use the CSV importer. The manual form on the Leads page is the fastest way to start.",
  },
  {
    q: "Why does the AI assistant say it is not configured?",
    a: "Generation needs AI_API_KEY (optionally AI_MODEL and AI_BASE_URL). Without it the assistant, lead scoring and automation AI steps report the missing configuration instead of inventing content. Rule-based lead scoring still works and is labelled as such.",
  },
  {
    q: "How do plan limits work?",
    a: "Every limit is checked on the server before the write happens — leads, AI generations per month, documents, automations and team members. Hitting a limit returns a clear message and never half-saves a record.",
  },
  {
    q: "How is a proposal marked as accepted?",
    a: "Only the client can accept, from the secure share link (/p/<token>). Staff cannot set accepted or rejected — the buttons are not exposed and the server action rejects those values.",
  },
  {
    q: "Why is Dropbox shown as not connected?",
    a: "Dropbox storage requires DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_ACCESS_TOKEN. Without them files are stored on the server under data/uploads and the database records storage_provider = local.",
  },
  {
    q: "How do I stop duplicate automation runs?",
    a: "Each automation execution carries an idempotency key derived from the record and the transition, with a unique constraint in the database. Replaying an event is a no-op and shows as 'duplicate blocked' in the history.",
  },
];

export default function HelpPage() {
  return (
    <>
      <MarketingHeader />
      <main className="mx-auto max-w-4xl px-4 py-14 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Help &amp; setup</h1>
        <p className="mt-2 text-[hsl(var(--fg-muted))]">
          Practical answers. Anything that needs credentials is called out explicitly — the product never pretends an
          integration is live.
        </p>

        <div className="mt-8 space-y-3">
          {faqs.map((f) => (
            <Card key={f.q}>
              <CardHeader>
                <CardTitle className="text-base">{f.q}</CardTitle>
                <CardDescription>{f.a}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>

        <h2 id="capture" className="mt-12 text-xl font-bold tracking-tight">Lead capture form snippet</h2>
        <p className="mt-2 text-sm text-[hsl(var(--fg-muted))]">
          Replace <code>ORG_SLUG</code> and <code>CAPTURE_KEY</code>. The endpoint validates each field, is rate limited per
          IP, respects your plan limit, and is closed entirely while <code>LEAD_CAPTURE_KEY</code> is unset.
        </p>
        <Card className="mt-3">
          <CardContent className="pt-5">
            <pre className="overflow-x-auto rounded-lg bg-[hsl(var(--muted))] p-3 text-xs">{`<form action="https://your-domain.com/api/leads/capture" method="post">
  <input type="hidden" name="org" value="ORG_SLUG" />
  <input type="hidden" name="source" value="website" />
  <input name="name" placeholder="Your name" required />
  <input name="email" type="email" placeholder="Email" />
  <input name="company" placeholder="Company" />
  <input name="phone" placeholder="Phone" />
  <textarea name="message" placeholder="How can we help?"></textarea>
  <!-- The capture key must not be embedded in public HTML. Proxy this form
       through your own serverless function and add the header there:
       x-capture-key: CAPTURE_KEY -->
  <button type="submit">Send</button>
</form>`}</pre>
          </CardContent>
        </Card>

        <div className="mt-6">
          <Alert tone="info" title="Need more detail?">
            The README in the repository covers migrations, environment variables, Stripe webhook setup and Dropbox OAuth
            step by step. Deployment notes are at the end of that file.
          </Alert>
        </div>

        <p className="mt-8 text-sm text-[hsl(var(--fg-muted))]">
          Still stuck? <Link href="/signup" className="underline">Create an account</Link> and open a support ticket from
          the app, or email the address configured in <code>EMAIL_FROM</code>.
        </p>
      </main>
      <MarketingFooter />
    </>
  );
}
