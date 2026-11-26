import type { Metadata } from "next";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader, StatCard } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { UploadDocumentForm, DeleteDocumentButton } from "@/components/documents/document-forms";
import { all, get } from "@/lib/db";
import { isDropboxConfigured } from "@/lib/storage";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Documents", robots: { index: false } };

export default async function DocumentsPage() {
  const ctx = await loadAppContext();

  const documents = all<{
    id: string; file_name: string; mime_type: string | null; size_bytes: number; storage_provider: string;
    created_at: string; customer_name: string | null;
  }>(
    `select d.id, d.file_name, d.mime_type, d.size_bytes, d.storage_provider, d.created_at, c.name as customer_name
       from documents d left join customers c on c.id = d.customer_id
      where d.organization_id = ? order by d.created_at desc limit 200`,
    [ctx.orgId]
  );

  const customers = all<{ id: string; name: string }>(
    "select id, name from customers where organization_id = ? and deleted_at is null order by name asc limit 200",
    [ctx.orgId]
  );

  const totals = get<{ count: number; bytes: number }>(
    "select count(*) as count, coalesce(sum(size_bytes),0) as bytes from documents where organization_id = ?",
    [ctx.orgId]
  ) ?? { count: 0, bytes: 0 };

  const dropboxReady = isDropboxConfigured();
  const tokenPresent = Boolean((process.env.DROPBOX_ACCESS_TOKEN ?? "").trim());

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
      <PageHeader title="Documents" description="Files attached to customers and proposals. Records stay in the database; only files go to storage." />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Files" value={String(totals.count)} hint={`Limit ${ctx.plan.document_limit.toLocaleString()}`} />
        <StatCard label="Storage used" value={`${(totals.bytes / 1024 / 1024).toFixed(2)} MB`} />
        <StatCard label="Dropbox" value={dropboxReady && tokenPresent ? "Connected" : "Not connected"} tone={dropboxReady && tokenPresent ? "good" : "warn"} />
      </div>

      {!dropboxReady ? (
        <div className="mb-4">
          <Alert tone="info" title="Files are stored on this server">
            Dropbox OAuth keys are not configured, so uploads are written to <code>data/uploads</code> and marked
            <code> storage_provider = local</code>. Add <code>DROPBOX_APP_KEY</code>, <code>DROPBOX_APP_SECRET</code> and{" "}
            <code>DROPBOX_ACCESS_TOKEN</code> to store files in Dropbox instead. See the README for the OAuth steps.
          </Alert>
        </div>
      ) : null}
      {dropboxReady && !tokenPresent ? (
        <div className="mb-4">
          <Alert tone="warning" title="Dropbox keys present, token missing">
            Complete the OAuth flow described in the README and set <code>DROPBOX_ACCESS_TOKEN</code>. Until then uploads stay local.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Upload</CardTitle>
            <CardDescription>Customer linking is optional.</CardDescription>
          </CardHeader>
          <CardContent>
            {ctx.can("document:upload") ? (
              <UploadDocumentForm customers={customers} />
            ) : (
              <p className="text-sm text-[hsl(var(--fg-muted))]">
                Your role can download files but not upload new ones.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="overflow-hidden lg:col-span-2">
          <CardHeader><CardTitle>Files</CardTitle></CardHeader>
          {documents.length === 0 ? (
            <EmptyState title="No files yet" description="Upload a contract, brief or signed agreement to attach it to a customer." />
          ) : (
            <Table>
              <THead><TR><TH>File</TH><TH>Customer</TH><TH>Storage</TH><TH className="text-right">Size</TH><TH>Uploaded</TH><TH /></TR></THead>
              <TBody>
                {documents.map((d) => (
                  <TR key={d.id}>
                    <TD className="font-medium">{d.file_name}<p className="text-xs text-[hsl(var(--fg-muted))]">{d.mime_type}</p></TD>
                    <TD className="text-[hsl(var(--fg-muted))]">{d.customer_name ?? "—"}</TD>
                    <TD><Badge tone={d.storage_provider === "dropbox" ? "brand" : "neutral"}>{d.storage_provider}</Badge></TD>
                    <TD className="text-right tabular-nums">{Math.max(1, Math.round(d.size_bytes / 1024))} KB</TD>
                    <TD className="text-[hsl(var(--fg-muted))]">{formatDate(d.created_at)}</TD>
                    <TD><DeleteDocumentButton documentId={d.id} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
