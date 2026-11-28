import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { get } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { membershipForUser } from "@/lib/auth";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { logoutAction } from "@/lib/actions/auth";

/**
 * The page a suspended workspace lands on.
 *
 * `requireAuth` redirects here instead of throwing, because a 500 tells the customer
 * nothing. This page deliberately does **not** call `requireAuth` (that would loop),
 * and it names the reason the platform owner recorded — a suspension the customer
 * cannot understand is a support ticket waiting to happen.
 */

export const metadata: Metadata = { title: "Workspace suspended", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function SuspendedPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const membership = membershipForUser(user.id);
  if (!membership) redirect("/onboarding");
  if (!membership.suspended_at) redirect("/dashboard");

  const org = get<{ suspension_reason: string | null; suspended_at: string | null }>(
    "select suspension_reason, suspended_at from organizations where id = ?",
    [membership.organization_id]
  );

  const supportEmail = (process.env.SUPPORT_EMAIL ?? process.env.ADMIN_EMAIL ?? "").trim();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-4 px-4 py-10">
      <div className="flex items-center gap-2 text-sm text-[hsl(var(--fg-muted))]">
        <ShieldAlert className="h-4 w-4" />
        {membership.organization_name}
      </div>

      <h1 className="text-2xl font-semibold">This workspace is suspended</h1>
      <p className="text-sm text-[hsl(var(--fg-muted))]">
        Your data is safe and nothing has been deleted. While the workspace is suspended every page of the app is
        closed to changes — including this one — so the way back in is to resolve the reason below with support.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>What the platform owner recorded</CardTitle>
          <CardDescription>
            {org?.suspended_at ? `Suspended on ${org.suspended_at.slice(0, 10)}` : "Suspension date not recorded"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert tone="warning" title="Reason">
            {org?.suspension_reason ?? "No reason was recorded. Ask support to add one — every suspension is supposed to carry a reason."}
          </Alert>
          <div className="mt-4 flex flex-wrap gap-2">
            {supportEmail ? (
              <a href={`mailto:${supportEmail}`}>
                <Button size="sm">Contact support</Button>
              </a>
            ) : null}
            <form action={logoutAction}>
              <Button type="submit" size="sm" variant="ghost">Sign out</Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
