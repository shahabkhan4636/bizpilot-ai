import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/auth-forms";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">B</span>
          BizPilot AI
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Choose a new password</CardTitle>
            <CardDescription>All other sessions will be signed out.</CardDescription>
          </CardHeader>
          <CardContent>
            {token ? (
              <ResetPasswordForm token={token} />
            ) : (
              <Alert tone="danger" title="Missing token">
                Open this page from the reset link. <Link href="/forgot-password" className="underline">Request a new one</Link>.
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
