import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { SignupForm } from "@/components/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Create your account", robots: { index: false } };

export default async function SignupPage() {
  if (await currentUser()) redirect("/dashboard");
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">B</span>
          BizPilot AI
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Create your workspace</CardTitle>
            <CardDescription>14-day trial on the Starter plan. No card required.</CardDescription>
          </CardHeader>
          <CardContent>
            <SignupForm />
            <p className="mt-4 text-center text-sm text-[hsl(var(--fg-muted))]">
              Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:underline">Sign in</Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
