"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Users, UserSquare2, Bot, FileText, FolderOpen, Workflow,
  BarChart3, CreditCard, Settings, ShieldCheck, LifeBuoy, Menu, X, LogOut, Plus, Inbox, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { Button } from "./ui/button";
import { logoutAction } from "@/lib/actions/auth";

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/leads", label: "Leads", icon: UserSquare2 },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/ai-assistant", label: "AI assistant", icon: Bot },
  { href: "/approvals", label: "Approvals", icon: Inbox },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/proposals", label: "Proposals", icon: FileText },
  { href: "/documents", label: "Documents", icon: FolderOpen },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/billing", label: "Billing", icon: CreditCard },
  { href: "/settings", label: "Settings", icon: Settings },
];

const secondary = [
  { href: "/admin", label: "Admin", icon: ShieldCheck },
  { href: "/help", label: "Help", icon: LifeBuoy },
];

export function AppShell({
  children,
  user,
  org,
  role,
  canWriteLeads,
  planName,
  trialDaysLeft,
  unreadNotifications = 0,
}: {
  children: React.ReactNode;
  user: { name: string; email: string; isSuperAdmin: boolean };
  org: { name: string };
  role: string;
  canWriteLeads?: boolean;
  planName: string;
  trialDaysLeft: number | null;
  unreadNotifications?: number;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center gap-2 border-b border-[hsl(var(--border))] px-4">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm font-bold text-white">B</span>
          <span className="truncate">BizPilot AI</span>
        </Link>
        <button className="ml-auto lg:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="border-b border-[hsl(var(--border))] px-4 py-3">
        <p className="truncate text-sm font-medium">{org.name}</p>
        <p className="text-xs text-[hsl(var(--fg-muted))]">
          {planName} plan · {role}
          {trialDaysLeft !== null && trialDaysLeft > 0 ? ` · trial ends in ${trialDaysLeft}d` : ""}
        </p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3 scrollbar-thin">
        {nav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
              isActive(item.href)
                ? "bg-brand-600 text-white"
                : "text-[hsl(var(--fg-muted))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--fg))]"
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
            {item.href === "/notifications" && unreadNotifications > 0 ? (
              <span className="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-white/20 px-1 text-[11px] font-semibold">
                {unreadNotifications > 99 ? "99+" : unreadNotifications}
              </span>
            ) : null}
          </Link>
        ))}
        <div className="my-2 border-t border-[hsl(var(--border))]" />
        {secondary
          .filter((s) => s.href !== "/admin" || user.isSuperAdmin)
          .map((item) => (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors",
                isActive(item.href)
                  ? "bg-brand-600 text-white"
                  : "text-[hsl(var(--fg-muted))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--fg))]"
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          ))}
      </nav>

      <div className="border-t border-[hsl(var(--border))] p-3">
        <div className="mb-2 flex items-center gap-2 px-1">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[hsl(var(--muted))] text-xs font-semibold">
            {user.name.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-[hsl(var(--fg-muted))]">{user.email}</p>
          </div>
        </div>
        <form action={logoutAction}>
          <Button type="submit" variant="outline" size="sm" className="w-full">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </Button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r border-[hsl(var(--border))] bg-[hsl(var(--surface))] lg:block">
        <div className="sticky top-0 h-screen">{sidebar}</div>
      </aside>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-72 bg-[hsl(var(--surface))] shadow-xl">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-[hsl(var(--border))] bg-[hsl(var(--bg))]/90 px-4 backdrop-blur">
          <button className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{org.name}</p>
            <p className="text-xs text-[hsl(var(--fg-muted))]">{planName} plan</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {canWriteLeads ? (
              <Link href="/leads?new=1" className="hidden sm:block">
                <Button size="sm"><Plus className="h-4 w-4" /> New lead</Button>
              </Link>
            ) : null}
            <ThemeToggle />
          </div>
        </header>
        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
