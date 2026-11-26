import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { LoginForm } from "@/components/auth-forms";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export const metadata: Metadata = { title: "Log in", robots: { index: false } };

export default async function LoginPage() {
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
            <CardTitle className="text-lg">Welcome back</CardTitle>
            <CardDescription>Sign in to your workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm />
            <p className="mt-4 text-center text-sm text-[hsl(var(--fg-muted))]">
              New here? <Link href="/signup" className="font-medium text-brand-600 hover:underline">Create an account</Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
