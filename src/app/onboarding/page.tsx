import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser, membershipForUser } from "@/lib/auth";
import { OnboardingForm } from "@/components/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Set up your workspaces", robots: { index: false } };

export default async function OnboardingPage() {
  const user = await requireUser();
  const membership = membershipForUser(user.id);
  if (!membership) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>No workspace found</CardTitle>
            <CardDescription>This account is not linked to an organisation. Contact support to be re-invited.</CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }
  if (user.onboarded_at) redirect("/dashboard");

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Welcome, {user.full_name ?? user.email}</CardTitle>
            <CardDescription>A few details so proposals, dates and totals look right.</CardDescription>
          </CardHeader>
          <CardContent>
            <OnboardingForm defaultName={membership.organization_name} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
