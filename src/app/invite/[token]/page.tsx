import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AcceptInviteForm } from "@/components/settings/invite-form";
import { inviteDetails } from "@/lib/actions/invites";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Workspace invitation", robots: { index: false, follow: false } };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await inviteDetails(token);

  if (!invite) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Invitation not found</CardTitle>
            <CardDescription>This link is invalid or has been revoked. Ask the workspace owner for a new invitation.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">B</span>
          BizPilot AI
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Join {invite.orgName}</CardTitle>
            <CardDescription>
              Invitation for {invite.email} as {invite.role} · expires {formatDate(invite.expiresAt)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invite.accepted ? (
              <Alert tone="success" title="Already accepted">
                This invitation has been used. <Link href="/login" className="underline">Sign in</Link> to continue.
              </Alert>
            ) : invite.expired ? (
              <Alert tone="danger" title="Invitation expired">
                Ask the workspace owner to send a new invitation.
              </Alert>
            ) : (
              <AcceptInviteForm token={token} hasAccount={invite.hasAccount} />
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
