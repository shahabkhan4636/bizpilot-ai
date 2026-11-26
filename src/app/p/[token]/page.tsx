import type { Metadata } from "next";
import { get, all } from "@/lib/db";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AcceptProposalForm, DeclineProposalForm } from "@/components/proposals/public-proposal";
import { formatMoney, formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Proposal", robots: { index: false, follow: false } };

/**
 * Public client portal page. Access is granted only by possession of the
 * share token; every query is additionally scoped to that proposal's
 * organisation so no other tenant record can be reached from here.
 */
export default async function PublicProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const proposal = get<{
    id: string; organization_id: string; title: string; client_name: string; client_email: string | null;
    summary: string | null; scope: string | null; terms: string | null; currency: string;
    subtotal_cents: number; tax_cents: number; total_cents: number; status: string; version: number;
    accepted_at: string | null; rejected_at: string | null; expires_at: string | null; created_at: string;
  }>("select * from proposals where share_token = ?", [token]);

  if (!proposal) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Link not found</CardTitle>
            <CardDescription>This proposal link is invalid or has been revoked. Ask the sender for a new link.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const business = get<{ name: string; email?: string }>(
    "select name from organizations where id = ?",
    [proposal.organization_id]
  );

  const items = all<{ id: string; description: string; quantity: number; unit_price_cents: number; amount_cents: number }>(
    "select id, description, quantity, unit_price_cents, amount_cents from proposal_items where proposal_id = ? and organization_id = ? order by sort_order asc",
    [proposal.id, proposal.organization_id]
  );

  const expired = proposal.expires_at ? new Date(proposal.expires_at) < new Date() : false;
  const closed = proposal.status === "accepted" || proposal.status === "rejected";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6">
        <p className="text-sm font-medium text-brand-600">{business?.name ?? "Proposal"}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">{proposal.title}</h1>
        <p className="mt-1 text-sm text-[hsl(var(--fg-muted))]">
          Prepared for {proposal.client_name} · v{proposal.version} · {formatDate(proposal.created_at)}
        </p>
      </div>

      {proposal.status === "accepted" ? (
        <div className="mb-4"><Alert tone="success" title="Accepted">You accepted this proposal on {formatDate(proposal.accepted_at ?? "")}. The sender has been notified.</Alert></div>
      ) : null}
      {proposal.status === "rejected" ? (
        <div className="mb-4"><Alert tone="warning" title="Declined">You declined this proposal on {formatDate(proposal.rejected_at ?? "")}.</Alert></div>
      ) : null}
      {expired && !closed ? (
        <div className="mb-4"><Alert tone="warning" title="Expired">This proposal expired on {formatDate(proposal.expires_at ?? "")}. Ask the sender to issue a new version.</Alert></div>
      ) : null}

      <Card className="mb-4">
        <CardHeader><CardTitle>Summary</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="whitespace-pre-wrap text-[hsl(var(--fg-muted))]">{proposal.summary ?? "See the line items below."}</p>
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
            <Row label="Subtotal" value={formatMoney(proposal.subtotal_cents, proposal.currency)} />
            <Row label="Tax" value={formatMoney(proposal.tax_cents, proposal.currency)} />
            <Row label="Total" value={formatMoney(proposal.total_cents, proposal.currency)} bold />
          </div>
          {proposal.scope ? <div><p className="font-medium">Scope</p><p className="whitespace-pre-wrap text-[hsl(var(--fg-muted))]">{proposal.scope}</p></div> : null}
          {proposal.terms ? <div><p className="font-medium">Terms</p><p className="whitespace-pre-wrap text-[hsl(var(--fg-muted))]">{proposal.terms}</p></div> : null}
        </CardContent>
      </Card>

      {!closed && !expired ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Accept</CardTitle><CardDescription>Confirming records your acceptance.</CardDescription></CardHeader>
            <CardContent><AcceptProposalForm token={token} /></CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Decline</CardTitle><CardDescription>Tell us why so we can adjust.</CardDescription></CardHeader>
            <CardContent><DeclineProposalForm token={token} /></CardContent>
          </Card>
        </div>
      ) : null}

      <p className="mt-8 text-center text-xs text-[hsl(var(--fg-muted))]">Sent with BizPilot AI</p>
    </main>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""}`}>
      <span className={bold ? "" : "text-[hsl(var(--fg-muted))]"}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
