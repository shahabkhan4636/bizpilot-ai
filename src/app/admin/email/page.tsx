import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, MailWarning, RotateCw, Trash2 } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { requireSuperAdmin } from "@/lib/auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  deleteOutboxEmailAction,
  retryAllEmailsAction,
  retryOutboxEmailAction,
} from "@/lib/actions/admin";
import { TestEmailForm } from "@/components/admin/email-forms";
import { listOutbox, outboxCounts, MAX_RETRIES, MAX_TOTAL_ATTEMPTS, RETRY_DELAYS_MINUTES } from "@/lib/email-outbox";
import { emailFromAddress, isEmailConfigured } from "@/lib/email";
import { relativeTime, formatDate } from "@/lib/utils";

/**
 * /admin/email — the outbox.
 *
 * Every transactional email writes a row before it is dispatched, so this page is
 * the answer to "did the invite actually go out?" and to "the reset link never
 * arrived". Failed rows are here with their exact provider error, and a retry
 * button that overrides the backoff clock.
 */

export const metadata: Metadata = { title: "Email outbox", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function AdminEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ retried?: string }>;
}) {
  await requireSuperAdmin();
  const ctx = await loadAppContext();
  const { retried } = await searchParams;

  const counts = outboxCounts();
  const pending = listOutbox({ status: "queued", limit: 50 });
  const failed = listOutbox({ status: "failed", limit: 50 });
  const recent = listOutbox({ status: "sent", limit: 10 });
  const configured = isEmailConfigured();

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
      <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> Admin
      </Link>

      <PageHeader
        title="Email outbox"
        description="Every transactional email is written here first, then dispatched. Nothing is reported as sent without a row."
      />

      {!configured ? (
        <div className="mb-4">
          <Alert tone="warning" title="Email is not configured on this deployment">
            <code>RESEND_API_KEY</code> is missing, so nothing can be sent. Messages are being <strong>queued, not
            lost</strong> — add the key and press “Retry everything”; they will go out from this queue.
          </Alert>
        </div>
      ) : (
        <div className="mb-4">
          <Alert tone="info" title="Sending is live">
            From address: <code>{emailFromAddress()}</code>. Retries: {RETRY_DELAYS_MINUTES.join(" min, ")} min, then
            the row needs a human decision ({MAX_RETRIES} retries). Retry worker:{" "}
            <code>GET /api/cron/email</code> with <code>Authorization: Bearer $CRON_SECRET</code>.
          </Alert>
        </div>
      )}

      {retried ? (
        <div className="mb-4">
          <Alert tone="success">{retried} message(s) were accepted by the provider in that retry.</Alert>
        </div>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Queued" value={String(counts.queued)} hint="Waiting for the provider / backoff" />
        <StatCard label="Failed" value={String(counts.failed)} hint={`After ${MAX_TOTAL_ATTEMPTS} attempts`} />
        <StatCard label="Sent" value={String(counts.sent)} hint="Accepted by Resend" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Needs attention</CardTitle>
              <CardDescription>Failed after every retry — the provider&apos;s own words, so you can fix the cause.</CardDescription>
            </CardHeader>
            {failed.length === 0 ? (
              <EmptyState title="Nothing failed" description="Any message that exhausts its retries appears here with its error." />
            ) : (
              <>
                <div className="border-b border-[hsl(var(--border))] px-4 py-3">
                  <form action={retryAllEmailsAction}>
                    <Button type="submit" size="sm" variant="outline">
                      <RotateCw className="h-4 w-4" /> Retry everything now
                    </Button>
                  </form>
                </div>
                <Table>
                  <THead><TR><TH>To</TH><TH>Subject</TH><TH>Attempts</TH><TH>Error</TH><TH /></TR></THead>
                  <TBody>
                    {failed.map((row) => (
                      <TR key={row.id}>
                        <TD className="font-mono text-xs">{row.to_email}</TD>
                        <TD className="max-w-[16rem] truncate">{row.subject}</TD>
                        <TD className="tabular-nums">{row.attempts}</TD>
                        <TD className="max-w-[18rem] truncate text-xs text-[hsl(var(--fg-muted))]" title={row.last_error ?? ""}>
                          {row.last_error ?? "—"}
                        </TD>
                        <TD>
                          <div className="flex items-center gap-1">
                            <form action={retryOutboxEmailAction}>
                              <input type="hidden" name="outbox_id" value={row.id} />
                              <Button type="submit" size="sm" variant="outline">Retry</Button>
                            </form>
                            <form action={deleteOutboxEmailAction}>
                              <input type="hidden" name="outbox_id" value={row.id} />
                              <Button type="submit" size="sm" variant="ghost" aria-label={`Delete email to ${row.to_email}`}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </form>
                          </div>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Queued</CardTitle>
              <CardDescription>
                Waiting for the next attempt. {configured ? "The retry worker sends these automatically." : "Nothing sends until RESEND_API_KEY exists — they are safe here."}
              </CardDescription>
            </CardHeader>
            {pending.length === 0 ? (
              <EmptyState title="Queue is empty" description="No message is waiting to be delivered." />
            ) : (
              <Table>
                <THead><TR><TH>Queued</TH><TH>To</TH><TH>Kind</TH><TH>Attempts</TH><TH>Next try</TH><TH /></TR></THead>
                <TBody>
                  {pending.map((row) => (
                    <TR key={row.id}>
                      <TD className="text-[hsl(var(--fg-muted))]">{relativeTime(row.created_at)}</TD>
                      <TD className="font-mono text-xs">{row.to_email}</TD>
                      <TD><Badge tone="neutral">{row.kind}</Badge></TD>
                      <TD className="tabular-nums">{row.attempts}</TD>
                      <TD className="text-xs text-[hsl(var(--fg-muted))]">
                        {row.next_attempt_at ? relativeTime(row.next_attempt_at) : "—"}
                      </TD>
                      <TD>
                        <form action={retryOutboxEmailAction}>
                          <input type="hidden" name="outbox_id" value={row.id} />
                          <Button type="submit" size="sm" variant="ghost">Retry now</Button>
                        </form>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader><CardTitle>Recently sent</CardTitle></CardHeader>
            {recent.length === 0 ? (
              <EmptyState title="Nothing sent yet" description="Delivered messages appear here with the provider's id." />
            ) : (
              <Table>
                <THead><TR><TH>Sent</TH><TH>To</TH><TH>Kind</TH><TH>Provider id</TH></TR></THead>
                <TBody>
                  {recent.map((row) => (
                    <TR key={row.id}>
                      <TD className="text-[hsl(var(--fg-muted))]">{formatDate(row.sent_at ?? row.created_at)}</TD>
                      <TD className="font-mono text-xs">{row.to_email}</TD>
                      <TD><Badge tone="success">{row.kind}</Badge></TD>
                      <TD className="font-mono text-[11px] text-[hsl(var(--fg-muted))]">{row.provider_message_id ?? "—"}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Send a test email</CardTitle>
              <CardDescription>
                The only proof that counts: one real message through the real provider, with its exact response.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TestEmailForm defaultTo={ctx.user.email} configured={configured} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>How delivery works</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm text-[hsl(var(--fg-muted))]">
              <p className="flex items-start gap-2">
                <MailWarning className="mt-0.5 h-4 w-4 shrink-0" />
                Row written <em>before</em> the HTTP call, so a crash mid-send is visible instead of invisible.
              </p>
              <p>
                A provider error burns one attempt and schedules the next at{" "}
                {RETRY_DELAYS_MINUTES.join(" min, ")} min. A <strong>missing API key never burns an attempt</strong> —
                the message waits for configuration instead of dying.
              </p>
              <p>
                After {MAX_TOTAL_ATTEMPTS} tries ({MAX_RETRIES} retries) the row is marked <Badge tone="danger">failed</Badge> and stops retrying
                automatically; the buttons above are the human decision.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
