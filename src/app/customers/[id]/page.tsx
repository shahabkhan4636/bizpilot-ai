import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { EditCustomerForm } from "@/components/customers/customer-forms";
import { deleteCustomerAction } from "@/lib/actions/customers";
import { all, get } from "@/lib/db";
import { formatMoney, formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Customer detail", robots: { index: false } };

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadAppContext();
  const orgId = ctx.orgId;

  const customer = get<{
    id: string; name: string; email: string | null; phone: string | null; company: string | null;
    address: string | null; notes: string | null; created_at: string;
  }>("select * from customers where id = ? and organization_id = ? and deleted_at is null", [id, orgId]);
  if (!customer) notFound();

  const leads = all<{ id: string; name: string; status: string; value_cents: number }>(
    "select id, name, status, value_cents from leads where organization_id = ? and customer_id = ? and deleted_at is null order by created_at desc",
    [orgId, id]
  );
  const proposals = all<{ id: string; title: string; status: string; total_cents: number; created_at: string }>(
    "select id, title, status, total_cents, created_at from proposals where organization_id = ? and customer_id = ? order by created_at desc",
    [orgId, id]
  );
  const documents = all<{ id: string; file_name: string; size_bytes: number; created_at: string }>(
    "select id, file_name, size_bytes, created_at from documents where organization_id = ? and customer_id = ? order by created_at desc",
    [orgId, id]
  );

  return (
    <AppShell
      user={{ name: ctx.displayName, email: ctx.user.email, isSuperAdmin: Boolean(ctx.user.is_super_admin) }}
      org={{ name: ctx.membership.organization_name }}
      role={ctx.membership.role}
      canWriteLeads={ctx.can("lead:write")}
      planName={ctx.plan.name}
      impersonation={ctx.impersonation}
      trialDaysLeft={ctx.trialDaysLeft}
      unreadNotifications={ctx.unreadNotifications}
    >
      <Link href="/customers" className="mb-4 inline-flex items-center gap-1 text-sm text-[hsl(var(--fg-muted))] hover:underline">
        <ArrowLeft className="h-4 w-4" /> All customers
      </Link>
      <PageHeader
        title={customer.name}
        description={`Customer since ${formatDate(customer.created_at)}${customer.company ? ` · ${customer.company}` : ""}`}
        actions={
          <>
            <Link href={`/proposals/new?customer=${customer.id}`}><Button size="sm" variant="outline">New proposal</Button></Link>
            <form action={deleteCustomerAction}>
              <input type="hidden" name="customer_id" value={customer.id} />
              <Button size="sm" variant="danger" type="submit"><Trash2 className="h-4 w-4" /> Delete</Button>
            </form>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Customer details</CardTitle>
            <CardDescription>Changes are saved to the database immediately.</CardDescription>
          </CardHeader>
          <CardContent><EditCustomerForm customer={customer} /></CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Linked leads</CardTitle></CardHeader>
            <CardContent>
              {leads.length === 0 ? <p className="text-sm text-[hsl(var(--fg-muted))]">No leads linked.</p> : (
                <div className="space-y-2">
                  {leads.map((l) => (
                    <Link key={l.id} href={`/leads/${l.id}`} className="flex items-center justify-between rounded-lg border border-[hsl(var(--border))] p-2 text-sm hover:bg-[hsl(var(--muted))]">
                      <span className="truncate">{l.name}</span>
                      <Badge>{l.status.replace(/_/g, " ")}</Badge>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Documents</CardTitle></CardHeader>
            <CardContent>
              {documents.length === 0 ? <p className="text-sm text-[hsl(var(--fg-muted))]">No files uploaded.</p> : (
                <div className="space-y-2">
                  {documents.map((d) => (
                    <div key={d.id} className="flex items-center justify-between text-sm">
                      <span className="truncate">{d.file_name}</span>
                      <span className="text-xs text-[hsl(var(--fg-muted))]">{Math.round(d.size_bytes / 1024)} KB</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-4 overflow-hidden">
        <CardHeader><CardTitle>Proposals</CardTitle></CardHeader>
        {proposals.length === 0 ? (
          <EmptyState title="No proposals for this customer" description="Create a priced proposal and share a secure link." action={<Link href={`/proposals/new?customer=${customer.id}`}><Button size="sm">Create proposal</Button></Link>} />
        ) : (
          <Table>
            <THead><TR><TH>Title</TH><TH>Status</TH><TH className="text-right">Total</TH><TH>Created</TH></TR></THead>
            <TBody>
              {proposals.map((p) => (
                <TR key={p.id}>
                  <TD><Link href={`/proposals/${p.id}`} className="font-medium hover:underline">{p.title}</Link></TD>
                  <TD className="capitalize">{p.status}</TD>
                  <TD className="text-right">{formatMoney(p.total_cents)}</TD>
                  <TD className="text-[hsl(var(--fg-muted))]">{formatDate(p.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </AppShell>
  );
}
