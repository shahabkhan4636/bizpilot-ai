import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Reset your password", robots: { index: false } };

export default function ForgotPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">B</span>
          BizPilot AI
        </Link>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Reset your password</CardTitle>
            <CardDescription>We will email you a link that expires in 24 hours.</CardDescription>
          </CardHeader>
          <CardContent><ForgotPasswordForm /></CardContent>
        </Card>
      </div>
    </main>
  );
}
