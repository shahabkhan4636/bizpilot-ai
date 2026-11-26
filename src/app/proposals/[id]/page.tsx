import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Download, ExternalLink, FileText } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ProposalEditor } from "@/components/proposals/proposal-editor";
import { CopyLinkButton, SendProposalButton, StatusButtons } from "@/components/proposals/proposal-actions";
import { proposalVersions, deleteProposalAction } from "@/lib/actions/proposals";
import { all, get } from "@/lib/db";
import { formatMoney, formatDate, relativeTime } from "@/lib/utils";

export const metadata: Metadata = { title: "Proposal", robots: { index: false } };

export default async function ProposalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadAppContext();
  const orgId = ctx.orgId;

  const proposal = get<{
    id: string; title: string; client_name: string; client_email: string | null; summary: string | null;
    scope: string | null; terms: string | null; currency: string; subtotal_cents: number; tax_cents: number;
    total_cents: number; status: string; share_token: string | null; version: number; accepted_at: string | null;
    rejected_at: string | null; expires_at: string | null; created_at: string; updated_at: string;
    customer_id: string | null; lead_id: string | null;
  }>("select * from proposals where id = ? and organization_id = ?", [id, orgId]);
  if (!proposal) notFound();

  const items = all<{ id: string; description: string; quantity: number; unit_price_cents: number; amount_cents: number }>(
    "select id, description, quantity, unit_price_cents, amount_cents from proposal_items where proposal_id = ? and organization_id = ? order by sort_order asc",
    [id, orgId]
  );
  const versions = await proposalVersions(orgId, id);
  const customers = all<{ id: string; name: string }>("select id, name from customers where organization_id = ? and deleted_at is null order by name asc limit 200", [orgId]);
  const leads = all<{ id: string; name: string }>("select id, name from leads where organization_id = ? and deleted_at is null order by created_at desc limit 200", [orgId]);

  const taxPercent = proposal.subtotal_cents > 0 ? Math.round((proposal.tax_cents / proposal.subtotal_cents) * 10000) / 100 : 0;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const shareUrl = proposal.share_token ? `${baseUrl}/p/${proposal.share_token}` : null;

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      planName={ctx.plan.name}
      trialDaysLeft={ctx.trialDaysLeft}
    >
      <Link href="/proposals" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> All proposals
      </Link>

      <PageHeader
        title={proposal.title}
        description={`${proposal.client_name} · v${proposal.version} · updated ${relativeTime(proposal.updated_at)}`}
        actions={
          <>
            <a
              href={`/api/proposals/pdf?id=${proposal.id}`}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              <Download className="h-4 w-4" /> PDF
            </a>
            {shareUrl ? (
              <a
                href={`/p/${proposal.share_token}`}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <ExternalLink className="h-4 w-4" /> Client view
              </a>
            ) : null}
            <form action={deleteProposalAction}>
              <input type="hidden" name="proposal_id" value={proposal.id} />
              <Button size="sm" variant="danger" type="submit">Delete</Button>
            </form>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Summary of work</CardTitle>
                <Badge tone={proposal.status === "accepted" ? "success" : proposal.status === "rejected" ? "danger" : proposal.status === "sent" ? "info" : "neutral"}>
                  {proposal.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="whitespace-pre-wrap text-[hsl(var(--fg-muted))]">{proposal.summary ?? "No summary yet."}</p>
              <Table>
                <THead><TR><TH>Description</TH><TH className="text-right">Qty</TH><TH className="text-right">Unit</TH><TH className="text-right">Amount</TH></TR></THead>
                <TBody>
                  {items.map((i) => (
                    <TR key={i.id}>
                      <TD>{i.description}</TD>
                      <TD className="text-right tabular-nums">{i.quantity}</TD>
                      <TD className="text-right tabular-nums">{formatMoney(i.unit_price_cents, proposal.currency)}</TD>
                      <TD className="text-right tabular-nums">{formatMoney(i.amount_cents, proposal.currency)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
              <div className="ml-auto w-full max-w-xs space-y-1 border-t border-[hsl(var(--border))] pt-2">
                <Line label="Subtotal" value={formatMoney(proposal.subtotal_cents, proposal.currency)} />
                <Line label={`Tax (${taxPercent}%)`} value={formatMoney(proposal.tax_cents, proposal.currency)} />
                <Line label="Total" value={formatMoney(proposal.total_cents, proposal.currency)} bold />
              </div>
              {proposal.scope ? (
                <div><p className="font-medium">Scope</p><p className="whitespace-pre-wrap text-[hsl(var(--fg-muted))]">{proposal.scope}</p></div>
              ) : null}
              {proposal.terms ? (
                <div><p className="font-medium">Terms</p><p className="whitespace-pre-wrap text-[hsl(var(--fg-muted))]">{proposal.terms}</p></div>
              ) : null}
            </CardContent>
          </Card>

          {proposal.status !== "accepted" ? (
            <Card>
              <CardHeader>
                <CardTitle>Edit proposal</CardTitle>
                <CardDescription>Saving creates version {proposal.version + 1} and keeps the previous version in history.</CardDescription>
              </CardHeader>
              <CardContent>
                <ProposalEditor
                  mode="edit"
                  proposal={proposal}
                  items={items}
                  taxPercent={taxPercent}
                  currency={proposal.currency}
                  clientName={proposal.client_name}
                  clientEmail={proposal.client_email ?? ""}
                  customerId={proposal.customer_id}
                  leadId={proposal.lead_id}
                  customers={customers}
                  leads={leads}
                />
              </CardContent>
            </Card>
          ) : (
            <Alert tone="success" title="Accepted by the client">
              Accepted {proposal.accepted_at ? formatDate(proposal.accepted_at) : ""}. Locked from further edits so the agreed
              figures cannot change.
            </Alert>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Share</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {shareUrl ? (
                <>
                  <p className="break-all rounded-lg bg-[hsl(var(--muted))] p-2 font-mono text-xs">{shareUrl}</p>
                  <div className="flex flex-wrap gap-2">
                    <CopyLinkButton url={shareUrl} />
                    <a href={`/p/${proposal.share_token}`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>Preview</a>
                  </div>
                  <p className="text-xs text-[hsl(var(--fg-muted))]">
                    Expires {proposal.expires_at ? formatDate(proposal.expires_at) : "—"}. Anyone with the link can accept or decline — this is the client portal.
                  </p>
                </>
              ) : (
                <p className="text-[hsl(var(--fg-muted))]">No share link yet. Mark the proposal as sent to generate one.</p>
              )}
              <SendProposalButton proposalId={proposal.id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Status</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <StatusButtons proposalId={proposal.id} status={proposal.status} />
              <div className="space-y-1 text-xs text-[hsl(var(--fg-muted))]">
                <p>Created {formatDate(proposal.created_at)}</p>
                {proposal.accepted_at ? <p>Accepted {formatDate(proposal.accepted_at)}</p> : null}
                {proposal.rejected_at ? <p>Declined {formatDate(proposal.rejected_at)}</p> : null}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Version history</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-brand-600" />
                <span>Version {proposal.version} (current)</span>
              </div>
              {versions.length === 0 ? (
                <p className="text-xs text-[hsl(var(--fg-muted))]">No earlier versions — this proposal has not been edited.</p>
              ) : (
                versions.map((v) => (
                  <div key={v.id} className="rounded-lg border border-[hsl(var(--border))] p-2 text-xs">
                    <p className="font-medium">{v.summary}</p>
                    <p className="text-[hsl(var(--fg-muted))]">
                      {relativeTime(v.created_at)} · total {formatMoney(v.meta.total_cents ?? 0, proposal.currency)}
                    </p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function Line({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className={bold ? "" : "text-[hsl(var(--fg-muted))]"}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
