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
import { dropboxAppConfigured, getCredential } from "@/lib/integrations";
import { buttonVariants } from "@/components/ui/button";
import { HardDrive } from "lucide-react";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Documents", robots: { index: false } };

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ dropbox?: string; reason?: string }>;
}) {
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

  const sp = await searchParams;
  const connectResult = sp.dropbox;
  const dropboxReady = dropboxAppConfigured();
  const credential = getCredential(ctx.orgId, "dropbox");
  const deploymentToken = Boolean((process.env.DROPBOX_ACCESS_TOKEN ?? "").trim());
  const connected = Boolean(credential) || deploymentToken;
  const canConnect = ctx.can("settings:workspace");

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
        <StatCard
          label="Dropbox"
          value={connected ? "Connected" : "Local storage"}
          tone={connected ? "good" : "warn"}
          hint={credential?.account_label ? `Account ${credential.account_label.slice(0, 12)}…` : undefined}
        />
      </div>

      {connectResult ? (
        <div className="mb-4">
          <Alert
            tone={connectResult === "connected" ? "success" : "danger"}
            title={
              connectResult === "connected"
                ? "Dropbox connected"
                : connectResult === "forbidden"
                  ? "Only a workspace owner or admin can connect Dropbox"
                  : "Dropbox was not connected"
            }
          >
            {connectResult === "connected"
              ? "New uploads are stored in this workspace's Dropbox account."
              : `Reason: ${connectResult.replace(/_/g, " ")}${sp.reason ? ` — ${sp.reason}` : ""}`}
          </Alert>
        </div>
      ) : null}

      {!connected ? (
        <div className="mb-4 space-y-3">
          <Alert tone="info" title="Files are stored on this server">
            Uploads are written to <code>data/uploads</code> and marked{" "}
            <code>storage_provider = local</code>.{" "}
            {dropboxReady
              ? "Connect this workspace's Dropbox to move new files into your own account — files already stored locally stay readable."
              : "Add DROPBOX_APP_KEY and DROPBOX_APP_SECRET to enable the Connect button."}
          </Alert>
          {dropboxReady && canConnect ? (
            <div>
              <a
                href="/api/integrations/dropbox/start"
                className={buttonVariants({ size: "sm", variant: "outline" })}
              >
                <HardDrive className="h-4 w-4" /> Connect Dropbox
              </a>
            </div>
          ) : null}
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
