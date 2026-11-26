import type { Metadata } from "next";
import { Bot } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AiWorkspace } from "@/components/ai/ai-workspace";
import { recentDrafts } from "@/lib/actions/ai";
import { all } from "@/lib/db";
import { isAiConfigured } from "@/lib/ai";
import { isEmailConfigured } from "@/lib/email";
import { relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "AI assistant", robots: { index: false } };

export default async function AiAssistantPage({ searchParams }: { searchParams: Promise<{ lead?: string; kind?: string }> }) {
  const ctx = await loadAppContext();
  const sp = await searchParams;

  const leads = all<{ id: string; name: string; email: string | null; company: string | null; notes: string | null }>(
    "select id, name, email, company, notes from leads where organization_id = ? and deleted_at is null order by created_at desc limit 200",
    [ctx.orgId]
  );
  const drafts = await recentDrafts(ctx.orgId);
  const aiConfigured = isAiConfigured();
  const emailConfigured = isEmailConfigured();

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
      <PageHeader
        title="AI sales assistant"
        description="Nine content types with tone, language and objective controls. Every send needs human approval."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="pt-4">
          <p className="text-xs uppercase tracking-wide text-[hsl(var(--fg-muted))]">AI provider</p>
          <p className="mt-1 flex items-center gap-2 text-sm font-semibold">
            <Bot className="h-4 w-4" /> {aiConfigured ? "Configured" : "Not configured"}
            <Badge tone={aiConfigured ? "success" : "warning"}>{aiConfigured ? "live" : "rule-based fallback"}</Badge>
          </p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs uppercase tracking-wide text-[hsl(var(--fg-muted))]">Generations this month</p>
          <p className="mt-1 text-sm font-semibold">{ctx.usage.aiThisMonth} of {ctx.plan.ai_generation_limit.toLocaleString()}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs uppercase tracking-wide text-[hsl(var(--fg-muted))]">Email delivery</p>
          <p className="mt-1 text-sm font-semibold">{emailConfigured ? "Configured (Resend)" : "Not configured"}</p>
        </CardContent></Card>
      </div>

      {!aiConfigured ? (
        <div className="mb-4">
          <Alert tone="warning" title="This deployment has no AI credentials">
            Set <code>AI_API_KEY</code> (plus optional <code>AI_MODEL</code> and <code>AI_BASE_URL</code>) to enable real
            generation. Until then the assistant reports the missing configuration and never fabricates content.
          </Alert>
        </div>
      ) : null}

      <AiWorkspace
        leads={leads}
        aiConfigured={aiConfigured}
        emailConfigured={emailConfigured}
        usage={ctx.usage.aiThisMonth}
        limit={ctx.plan.ai_generation_limit}
        defaultKind={sp.kind ?? "sales_email"}
        defaultLead={sp.lead ?? ""}
        businessName={ctx.membership.organization_name}
      />

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Recent drafts &amp; messages</CardTitle>
          <CardDescription>Everything generated or written here, with its real delivery state.</CardDescription>
        </CardHeader>
        <CardContent>
          {drafts.length === 0 ? (
            <p className="py-4 text-center text-sm text-[hsl(var(--fg-muted))]">Nothing yet — generate your first draft above.</p>
          ) : (
            <div className="space-y-2">
              {drafts.map((d) => (
                <details key={d.id} className="rounded-lg border border-[hsl(var(--border))] p-3">
                  <summary className="flex cursor-pointer items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-medium">{d.subject ?? "Untitled"}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Badge tone={d.status === "sent" ? "success" : d.status === "failed" ? "danger" : d.status === "approved_unsent" ? "warning" : "neutral"}>
                        {d.status.replace(/_/g, " ")}
                      </Badge>
                      <span className="text-xs text-[hsl(var(--fg-muted))]">{relativeTime(d.created_at)}</span>
                    </span>
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-[hsl(var(--fg-muted))]">{d.body}</pre>
                </details>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
