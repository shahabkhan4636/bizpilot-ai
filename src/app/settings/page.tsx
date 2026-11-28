import type { Metadata } from "next";
import { loadAppContext } from "@/lib/app-context";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { ProfileForm, PasswordForm, WorkspaceForm, MemberRoleForm, RemoveMemberButton } from "@/components/settings/settings-forms";
import { InviteMemberForm } from "@/components/settings/invite-form";
import { VerifyEmailCard, DeleteAccountCard } from "@/components/settings/account-forms";
import { isEmailVerified } from "@/lib/email-verification";
import { revokeInviteAction } from "@/lib/actions/invites";
import { all, get } from "@/lib/db";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

export default async function SettingsPage() {
  const ctx = await loadAppContext();
  const org = get<{ name: string; timezone: string; currency: string; business_type: string | null; website: string | null; phone: string | null; created_at: string }>(
    "select name, timezone, currency, business_type, website, phone, created_at from organizations where id = ?",
    [ctx.orgId]
  );
  const members = all<{ user_id: string; email: string; full_name: string | null; role: string; created_at: string }>(
    `select m.user_id, p.email, p.full_name, m.role, m.created_at
       from organization_members m join profiles p on p.id = m.user_id
      where m.organization_id = ? order by m.created_at asc`,
    [ctx.orgId]
  );

  const isOwner = ctx.membership.role === "owner";
  const invites = all<{ id: string; email: string; role: string; expires_at: string; created_at: string }>(
    `select id, email, role, expires_at, created_at from org_invites
      where organization_id = ? and accepted_at is null and expires_at > ? order by created_at desc`,
    [ctx.orgId, new Date().toISOString()]
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
      <PageHeader title="Settings" description="Your profile, workspace details and team." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Your profile</CardTitle></CardHeader>
          <CardContent><ProfileForm fullName={ctx.user.full_name ?? ""} email={ctx.user.email} /></CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>Passwords are stored as scrypt hashes with per-user salts.</CardDescription>
          </CardHeader>
          <CardContent><PasswordForm /></CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>
              Created {org ? formatDate(org.created_at) : "—"} · plan {ctx.plan.name} ({ctx.plan.member_limit} member{ctx.plan.member_limit === 1 ? "" : "s"})
            </CardDescription>
          </CardHeader>
          <CardContent>{org ? <WorkspaceForm org={org} /> : null}</CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Team members</CardTitle>
            <CardDescription>{members.length} of {ctx.plan.member_limit} seat(s) used on the {ctx.plan.name} plan.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <InviteMemberForm canManage={ctx.canManage} />
            {invites.length > 0 ? (
              <div className="rounded-lg border border-[hsl(var(--border))] p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[hsl(var(--fg-muted))]">
                  Pending invitations ({invites.length})
                </p>
                <div className="space-y-2">
                  {invites.map((i) => (
                    <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">{i.email}</span>
                      <span className="flex items-center gap-2 text-xs text-[hsl(var(--fg-muted))]">
                        <Badge>{i.role}</Badge>
                        expires {formatDate(i.expires_at)}
                        {ctx.canManage ? (
                          <form action={revokeInviteAction}>
                            <input type="hidden" name="invite_id" value={i.id} />
                            <Button type="submit" size="sm" variant="ghost">Revoke</Button>
                          </form>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <Table>
              <THead><TR><TH>Member</TH><TH>Role</TH><TH>Joined</TH><TH /></TR></THead>
              <TBody>
                {members.map((m) => (
                  <TR key={m.user_id}>
                    <TD>
                      <p className="font-medium">{m.full_name ?? m.email}</p>
                      <p className="text-xs text-[hsl(var(--fg-muted))]">{m.email}</p>
                    </TD>
                    <TD>
                      <div className="flex items-center gap-2">
                        <MemberRoleForm userId={m.user_id} role={m.role} canManage={isOwner && m.user_id !== ctx.user.id} />
                        {m.user_id === ctx.user.id ? <Badge tone="brand">you</Badge> : null}
                      </div>
                    </TD>
                    <TD className="text-[hsl(var(--fg-muted))]">{formatDate(m.created_at)}</TD>
                    <TD>
                      {m.user_id !== ctx.user.id ? <RemoveMemberButton userId={m.user_id} /> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Security</CardTitle>
            <CardDescription>What this deployment enforces today.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
            <Item label="Password hashing" value="scrypt + per-user salt, timing-safe compare" />
            <Item label="Session cookies" value="HttpOnly, SameSite=Lax, Secure in production" />
            <Item label="Tenant isolation" value="organization_id on every query; Postgres RLS in the SQL schema" />
            <Item label="Rate limiting" value="Login, sign-up, password reset, AI generation" />
            <Item label="Audit log" value="Privileged actions written to audit_logs" />
            <Item label="Stripe webhooks" value="HMAC-SHA256 signature + 5-minute tolerance + event dedupe" />
          </CardContent>
        </Card>
      </div>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Email verification</CardTitle>
          <CardDescription>Confirm the address password resets are sent to.</CardDescription>
        </CardHeader>
        <CardContent>
          <VerifyEmailCard verified={isEmailVerified(ctx.user.id)} email={ctx.user.email} />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Leaving the platform, or closing the workspace for good.</CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteAccountCard role={ctx.membership.role} memberCount={members.length} />
        </CardContent>
      </Card>

    </AppShell>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border))] p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--fg-muted))]">{label}</p>
      <p className="mt-1">{value}</p>
    </div>
  );
}
