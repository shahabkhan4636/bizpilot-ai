import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { get } from "@/lib/db";
import { isAiConfigured } from "@/lib/ai";
import { leadHunterBusiness } from "@/lib/lead-hunter";
import { LeadHunterChat } from "@/components/lead-hunter-chat";

export const metadata: Metadata = { title: "Chat with us", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Public website chat for one workspace, addressed by slug so the same deployment can
 * serve several workspaces later. No sign-in, no key in the browser: the page calls a
 * server action, which is where the rate limit, the AI call and the lead insert live.
 */
export default async function ChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const cleanSlug = decodeURIComponent(slug ?? "").trim().toLowerCase().slice(0, 80);
  const org = cleanSlug
    ? get<{ name: string; suspended_at: string | null }>("select name, suspended_at from organizations where slug = ?", [cleanSlug])
    : undefined;
  if (!org || org.suspended_at) notFound();

  const business = leadHunterBusiness();
  const name = org.name || business.name;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-4 px-4 py-8">
      <div className="text-center">
        <h1 className="text-xl font-semibold">Chat with {name}</h1>
        <p className="mt-1 text-sm text-[hsl(var(--fg-muted))]">
          A few quick questions so we don&apos;t waste your time. This is an AI assistant — ask for a human any time.
        </p>
      </div>

      {isAiConfigured() ? (
        <LeadHunterChat slug={cleanSlug} businessName={name} />
      ) : (
        <div className="rounded-2xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-6 text-center shadow-sm">
          <p className="font-medium">The chat assistant is not switched on yet.</p>
          <p className="mt-2 text-sm text-[hsl(var(--fg-muted))]">
            Add an AI key to this deployment to enable it. Until then, email {name} directly and you will get a
            personal reply.
          </p>
        </div>
      )}

      <p className="text-center text-xs text-[hsl(var(--fg-muted))]">
        Powered by{" "}
        <Link href="/" className="font-medium text-brand-600 hover:underline">
          BizPilot AI
        </Link>
      </p>
    </main>
  );
}
