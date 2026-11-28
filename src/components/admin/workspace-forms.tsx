"use client";

import { useActionState, useState } from "react";
import { Ban, CheckCircle2, LogIn, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select } from "@/components/ui/input";
import {
  applyWorkspacePlanAction,
  startImpersonationAction,
  suspendWorkspaceAction,
  unsuspendWorkspaceAction,
  type AdminWorkspaceState,
} from "@/lib/actions/admin-workspaces";

/** Suspending someone's access is never a one-click action: the reason is required. */
export function SuspendWorkspaceForm({ organizationId, suspended }: { organizationId: string; suspended: boolean }) {
  const [suspendState, suspendAction, suspending] = useActionState(suspendWorkspaceAction, null as AdminWorkspaceState);
  const [restoreState, restoreAction, restoring] = useActionState(unsuspendWorkspaceAction, null as AdminWorkspaceState);
  const [reason, setReason] = useState("");

  const state = suspended ? restoreState : suspendState;

  return (
    <div className="space-y-3">
      {state?.error ? <Alert tone="danger" title="Not saved">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <p className="text-sm text-[hsl(var(--fg-muted))]">
        {suspended
          ? "Restoring re-enables writes immediately and emails the workspace owner."
          : "Suspending blocks every write for this workspace. The customer keeps read access to billing and is shown your reason."}
      </p>

      <form action={suspended ? restoreAction : suspendAction} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="organization_id" value={organizationId} />
        <div className="space-y-1">
          <Label htmlFor="suspension-reason" className="text-xs">
            {suspended ? "Reason for restoring (audited)" : "Reason for suspending (the customer reads this)"}
          </Label>
          <Input
            id="suspension-reason"
            name="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            minLength={5}
            maxLength={500}
            className="h-9 w-80"
            placeholder={suspended ? "e.g. invoice paid — restoring access" : "e.g. payment failed after 3 reminders"}
          />
        </div>
        <Button type="submit" size="sm" variant={suspended ? "default" : "danger"} disabled={suspending || restoring}>
          {suspended ? <CheckCircle2 className="h-4 w-4" /> : <Ban className="h-4 w-4" />}
          {suspended ? (restoring ? "Restoring…" : "Restore workspace") : suspending ? "Suspending…" : "Suspend workspace"}
        </Button>
      </form>
    </div>
  );
}

/** Plan assignment for support — explicitly not a sale. */
export function WorkspacePlanForm({
  organizationId,
  planCode,
  plans,
}: {
  organizationId: string;
  planCode: string;
  plans: { code: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(applyWorkspacePlanAction, null as AdminWorkspaceState);
  return (
    <form action={action} className="space-y-2">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      <input type="hidden" name="organization_id" value={organizationId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="workspace-plan" className="text-xs">Plan (no charge is made)</Label>
          <Select id="workspace-plan" name="plan_code" defaultValue={planCode} className="h-9 w-52">
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>{plan.name}</option>
            ))}
          </Select>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          <Save className="h-4 w-4" /> {pending ? "Applying…" : "Apply plan"}
        </Button>
      </div>
    </form>
  );
}

/** Per-member "view as this user" button. Posts and redirects — nothing to undo by hand. */
export function ImpersonateButton({
  userId,
  organizationId,
  label,
}: {
  userId: string;
  organizationId: string;
  label: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <form
      action={startImpersonationAction}
      onSubmit={() => setPending(true)}
      className="inline"
    >
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="organization_id" value={organizationId} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending} title={`View the workspace as ${label} (read-only)`}>
        <LogIn className="h-3.5 w-3.5" /> {pending ? "Opening…" : "Impersonate"}
      </Button>
    </form>
  );
}

/** Shared pagination footer for the admin list pages. */
export function AdminPager({
  page,
  perPage,
  total,
  basePath,
  query,
}: {
  page: number;
  perPage: number;
  total: number;
  basePath: string;
  query: Record<string, string>;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const build = (target: number) => {
    const params = new URLSearchParams({ ...query, page: String(target) });
    return `${basePath}?${params.toString()}`;
  };
  const first = total === 0 ? 0 : (page - 1) * perPage + 1;
  const last = Math.min(total, page * perPage);

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[hsl(var(--fg-muted))]">
      <span>
        {first}–{last} of {total}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <a className="underline" href={build(page - 1)}>← Previous</a>
        ) : null}
        <span>
          page {page} / {pages}
        </span>
        {page < pages ? (
          <a className="underline" href={build(page + 1)}>Next →</a>
        ) : null}
      </div>
    </div>
  );
}
