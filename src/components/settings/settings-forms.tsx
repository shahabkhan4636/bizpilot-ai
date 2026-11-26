"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select } from "@/components/ui/input";
import {
  updateProfileAction, changePasswordAction, updateWorkspaceAction,
  updateMemberRoleAction, removeMemberAction, type SettingsState,
} from "@/lib/actions/settings";

function Feedback({ state }: { state: SettingsState }) {
  if (!state) return null;
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.notice) return <Alert tone="success">{state.notice}</Alert>;
  return null;
}

export function ProfileForm({ fullName, email }: { fullName: string; email: string }) {
  const [state, action, pending] = useActionState(updateProfileAction, null as SettingsState);
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <div className="space-y-1.5">
        <Label htmlFor="full_name">Full name</Label>
        <Input id="full_name" name="full_name" defaultValue={fullName} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="email-readonly">Email</Label>
        <Input id="email-readonly" value={email} readOnly disabled />
        <p className="text-xs text-[hsl(var(--fg-muted))]">Email changes need support verification — it is the account recovery address.</p>
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save profile"}</Button>
    </form>
  );
}

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, null as SettingsState);
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <div className="space-y-1.5">
        <Label htmlFor="current_password">Current password</Label>
        <Input id="current_password" name="current_password" type="password" autoComplete="current-password" required />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="new_password">New password</Label>
          <Input id="new_password" name="new_password" type="password" autoComplete="new-password" minLength={10} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm_password">Confirm new password</Label>
          <Input id="confirm_password" name="confirm_password" type="password" autoComplete="new-password" minLength={10} required />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Changing…" : "Change password"}</Button>
    </form>
  );
}

export function WorkspaceForm({
  org,
}: {
  org: { name: string; timezone: string; currency: string; business_type: string | null; website: string | null; phone: string | null };
}) {
  const [state, action, pending] = useActionState(updateWorkspaceAction, null as SettingsState);
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Workspace name</Label>
          <Input id="name" name="name" defaultValue={org.name} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="business_type">Business type</Label>
          <Input id="business_type" name="business_type" defaultValue={org.business_type ?? ""} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="timezone">Timezone</Label>
          <Select id="timezone" name="timezone" defaultValue={org.timezone}>
            {["UTC", "Asia/Karachi", "Asia/Dubai", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"].map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="currency">Currency</Label>
          <Select id="currency" name="currency" defaultValue={org.currency}>
            {["USD", "PKR", "GBP", "EUR", "AED", "CAD", "AUD", "INR"].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="website">Website</Label>
          <Input id="website" name="website" defaultValue={org.website ?? ""} placeholder="https://" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" defaultValue={org.phone ?? ""} />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save workspace"}</Button>
    </form>
  );
}

export function MemberRoleForm({ userId, role, canManage }: { userId: string; role: string; canManage: boolean }) {
  const [state, action, pending] = useActionState(updateMemberRoleAction, null as SettingsState);
  if (!canManage) return <span className="text-xs capitalize text-[hsl(var(--fg-muted))]">{role}</span>;
  return (
    <form action={action} className="flex items-center gap-1">
      <input type="hidden" name="user_id" value={userId} />
      <Select name="role" defaultValue={role} className="h-8 w-auto text-xs" aria-label="Role">
        <option value="member">Member</option>
        <option value="admin">Admin</option>
        <option value="owner">Owner</option>
      </Select>
      <Button type="submit" size="sm" variant="ghost" disabled={pending}>Set</Button>
      {state?.error ? <span className="text-xs text-red-600">{state.error}</span> : null}
    </form>
  );
}

export function RemoveMemberButton({ userId }: { userId: string }) {
  return (
    <form action={removeMemberAction}>
      <input type="hidden" name="user_id" value={userId} />
      <Button type="submit" size="sm" variant="ghost">Remove</Button>
    </form>
  );
}
