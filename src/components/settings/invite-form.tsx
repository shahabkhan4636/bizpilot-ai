"use client";

import { useActionState, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select } from "@/components/ui/input";
import { inviteMemberAction, acceptInviteAction, type InviteState } from "@/lib/actions/invites";
import { ROLES, ROLE_LABEL, ROLE_DESCRIPTION, type Role } from "@/lib/permissions";

export function InviteMemberForm({ canManage }: { canManage: boolean }) {
  const [state, action, pending] = useActionState(inviteMemberAction, null as InviteState);
  const [role, setRole] = useState<Role>("member");
  if (!canManage) return <p className="text-sm text-[hsl(var(--fg-muted))]">Only an owner or admin can invite people.</p>;
  return (
    <form action={action} className="space-y-3">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? (
        <Alert tone={state.link ? "warning" : "success"}>
          <p>{state.notice}</p>
          {state.link ? (
            <p className="mt-2 break-all font-mono text-xs">
              <a href={state.link} className="underline">{state.link}</a>
            </p>
          ) : null}
        </Alert>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="invite_email">Email address</Label>
          <Input id="invite_email" name="email" type="email" placeholder="teammate@company.com" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite_role">Role</Label>
          <Select id="invite_role" name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.filter((r) => r !== "owner").map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </Select>
          <p className="text-xs text-[hsl(var(--fg-muted))]">{ROLE_DESCRIPTION[role]}</p>
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        <UserPlus className="h-4 w-4" /> {pending ? "Sending…" : "Send invitation"}
      </Button>
    </form>
  );
}

export function AcceptInviteForm({ token, hasAccount }: { token: string; hasAccount: boolean }) {
  const [state, action, pending] = useActionState(acceptInviteAction, null as InviteState);
  return (
    <form action={action} className="space-y-3">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <input type="hidden" name="token" value={token} />
      {hasAccount ? (
        <Alert tone="info" title="You already have an account">
          Enter your existing password to join this workspace. The invitation link alone cannot take over your account.
        </Alert>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="full_name">Your name</Label>
          <Input id="full_name" name="full_name" placeholder="Ayesha Khan" required minLength={2} />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="password">{hasAccount ? "Your password" : "Choose a password"}</Label>
        <Input id="password" name="password" type="password" required minLength={hasAccount ? 1 : 10} autoComplete={hasAccount ? "current-password" : "new-password"} />
        {!hasAccount ? <p className="text-xs text-[hsl(var(--fg-muted))]">10+ characters with at least one letter and one number.</p> : null}
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Joining…" : hasAccount ? "Join workspace" : "Create account & join"}
      </Button>
    </form>
  );
}
