"use client";

import { useActionState, useState } from "react";
import { MailCheck, ShieldAlert, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label } from "@/components/ui/input";
import { resendVerificationAction, deleteAccountAction, type AccountState } from "@/lib/actions/account";

export function VerifyEmailCard({ verified, email }: { verified: boolean; email: string }) {
  const [state, action, pending] = useActionState(resendVerificationAction, null as AccountState);
  if (verified) {
    return (
      <Alert tone="success" title="Email verified">
        {email} is confirmed.
      </Alert>
    );
  }
  return (
    <div className="space-y-3">
      <Alert tone="warning" title="Your email is not verified yet">
        Verifying proves you own {email}. It is not required to use the workspace, but it is needed for password resets
        to reach you reliably.
      </Alert>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? (
        <Alert tone={state.link ? "warning" : "success"}>
          <p>{state.notice}</p>
          {state.link ? (
            <p className="mt-2 break-all font-mono text-xs">
              <a className="underline" href={state.link}>{state.link}</a>
            </p>
          ) : null}
        </Alert>
      ) : null}
      <form action={action}>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          <MailCheck className="h-4 w-4" /> {pending ? "Preparing…" : "Send verification link"}
        </Button>
      </form>
    </div>
  );
}

export function DeleteAccountCard({ role, memberCount }: { role: string; memberCount: number }) {
  const [state, action, pending] = useActionState(deleteAccountAction, null as AccountState);
  const [open, setOpen] = useState(false);
  const blocked = role === "owner" && memberCount > 1;

  return (
    <div className="space-y-3">
      <Alert tone="danger" title="Danger zone">
        Deleting your account removes your profile and sign-in permanently.
        {blocked
          ? " Because you own a workspace that still has other members, you must transfer ownership or remove them first."
          : memberCount <= 1
            ? " You are the only member, so the workspace and all of its leads, proposals and documents are deleted too. This cannot be undone."
            : " Your membership is removed; the workspace stays with its owner."}
      </Alert>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {!open ? (
        <Button type="button" size="sm" variant="danger" onClick={() => setOpen(true)} disabled={blocked}>
          <ShieldAlert className="h-4 w-4" /> Delete my account
        </Button>
      ) : (
        <form action={action} className="space-y-3 rounded-lg border border-red-200 p-3 dark:border-red-900">
          <div className="space-y-1.5">
            <Label htmlFor="delete_password">Your password</Label>
            <Input id="delete_password" name="password" type="password" required autoComplete="current-password" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delete_confirm">Type DELETE to confirm</Label>
            <Input id="delete_confirm" name="confirm" required placeholder="DELETE" />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="danger" disabled={pending}>
              <Trash2 className="h-4 w-4" /> {pending ? "Deleting…" : "Delete permanently"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  );
}
