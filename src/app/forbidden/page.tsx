import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";

export default async function ForbiddenPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const sp = await searchParams;
  const { membership } = await requireAuth().catch(() => redirect("/login"));
  const permission = sp.permission ?? "that action";

  return (
    <div className="mx-auto max-w-xl py-10">
      <Card>
        <CardHeader>
          <CardTitle>You do not have permission for that</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-[hsl(var(--fg-muted))]">
          <p>
            Your role in <strong>{membership.organization_name}</strong> is{" "}
            <strong>{membership.role}</strong>, which does not include{" "}
            <code className="rounded bg-[hsl(var(--bg-subtle))] px-1 py-0.5">{permission}</code>.
          </p>
          <p>
            Nothing was changed. Ask a workspace owner or admin if you need this access — they can
            change your role from Settings → Team.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/dashboard" className={buttonVariants({ size: "sm" })}>
              <Button size="sm" variant="outline">Back to dashboard</Button>
            </Link>
            <Link href="/settings" className={buttonVariants({ size: "sm", variant: "outline" })}>
              View my role
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
