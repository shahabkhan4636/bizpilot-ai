import type { Metadata } from "next";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { consumeVerificationToken } from "@/lib/email-verification";

export const metadata: Metadata = { title: "Verify your email", robots: { index: false, follow: false } };

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Verification link missing</CardTitle>
            <CardDescription>Open the link from the email, or request a new one from your dashboard.</CardDescription>
          </CardHeader>
          <CardContent>
            <Link className="underline" href="/dashboard">Back to the dashboard</Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const result = consumeVerificationToken(token);

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>{result.ok ? "Email verified" : "This link cannot be used"}</CardTitle>
          <CardDescription>
            {result.ok ? result.email : "Verification links are single use and expire after 48 hours."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {result.ok ? (
            <Alert tone="success" title="Thanks — your address is confirmed">
              You can close this page.
            </Alert>
          ) : (
            <Alert tone="warning" title={result.reason === "expired" ? "Link expired" : result.reason === "used" ? "Already used" : "Invalid link"}>
              Request a fresh link from your dashboard; it only takes a second.
            </Alert>
          )}
          <Link className="underline" href="/dashboard">Go to the dashboard</Link>
        </CardContent>
      </Card>
    </main>
  );
}
