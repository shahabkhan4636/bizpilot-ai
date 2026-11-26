import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="text-center">
        <p className="text-6xl font-bold tracking-tight text-brand-600">404</p>
        <h1 className="mt-3 text-xl font-semibold">That page does not exist</h1>
        <p className="mt-2 text-sm text-[hsl(var(--fg-muted))]">The link may be old, or the record may have been deleted.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/dashboard"><Button size="sm">Go to dashboard</Button></Link>
          <Link href="/"><Button size="sm" variant="outline">Home</Button></Link>
        </div>
      </div>
    </main>
  );
}
