"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Route-level error boundary. Shows a usable message (never a stack trace) and
 * reports the error to the browser console with a digest that matches the server
 * log line, so a user's report can be traced to the exact failure.
 */
export default function RouteError({error, reset}: {error: Error & { digest?: string }; reset: () => void}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "unhandled route error",
        digest: error.digest,
        error: error.message,
        time: new Date().toISOString(),
      })
    );
  }, [error]);

  return (
    <main className="grid min-h-[70vh] place-items-center px-4">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>
            The page could not be rendered. Nothing was saved for this action. If it keeps happening, contact support
            with the reference below.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert tone="danger" title="Reference">
            <code className="text-xs">{error.digest ?? error.message.slice(0, 120)}</code>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button onClick={reset}>Try again</Button>
            <Link
              href="/dashboard"
              className="inline-flex h-9 items-center rounded-lg border border-[hsl(var(--border))] px-4 text-sm font-medium hover:bg-[hsl(var(--muted))]"
            >
              Back to the dashboard
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
