import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";

const links = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/help", label: "Help" },
];

export function MarketingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[hsl(var(--border))] bg-[hsl(var(--bg))]/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">B</span>
          BizPilot AI
        </Link>
        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="rounded-md px-3 py-2 text-sm text-[hsl(var(--fg-muted))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--fg))]">
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className="hidden sm:block">
            <Button variant="ghost" size="sm">Log in</Button>
          </Link>
          <Link href="/signup">
            <Button size="sm">Start free trial</Button>
          </Link>
        </div>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-[hsl(var(--border))] py-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 sm:px-6 md:flex-row md:justify-between">
        <div>
          <p className="font-semibold">BizPilot AI</p>
          <p className="mt-1 max-w-sm text-sm text-[hsl(var(--fg-muted))]">
            AI business automation for small teams. Built to be deployed and sold — see the README for setup.
          </p>
        </div>
        <div className="flex gap-10 text-sm">
          <div className="flex flex-col gap-2">
            <p className="font-medium">Product</p>
            <Link href="/features" className="text-[hsl(var(--fg-muted))] hover:text-[hsl(var(--fg))]">Features</Link>
            <Link href="/pricing" className="text-[hsl(var(--fg-muted))] hover:text-[hsl(var(--fg))]">Pricing</Link>
            <Link href="/signup" className="text-[hsl(var(--fg-muted))] hover:text-[hsl(var(--fg))]">Sign up</Link>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-medium">Legal</p>
            <Link href="/privacy" className="text-[hsl(var(--fg-muted))] hover:text-[hsl(var(--fg))]">Privacy</Link>
            <Link href="/terms" className="text-[hsl(var(--fg-muted))] hover:text-[hsl(var(--fg))]">Terms</Link>
            <Link href="/help" className="text-[hsl(var(--fg-muted))] hover:text-[hsl(var(--fg))]">Support</Link>
          </div>
        </div>
      </div>
      <p className="mx-auto mt-8 max-w-6xl px-4 text-xs text-[hsl(var(--fg-muted))] sm:px-6">
        © {new Date().getFullYear()} BizPilot AI. No fabricated customers, reviews or revenue figures appear on this site.
      </p>
    </footer>
  );
}
