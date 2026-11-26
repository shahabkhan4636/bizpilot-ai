"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Input, Select } from "@/components/ui/input";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/csv";

export function LeadFilters({ members }: { members: { user_id: string; label: string }[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");

  function push(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    sp.delete("page");
    router.push(`/leads?${sp.toString()}`);
  }

  // Debounced search so typing does not fire a request per keystroke.
  useEffect(() => {
    const current = params.get("q") ?? "";
    if (q === current) return;
    const t = setTimeout(() => push({ q: q || null }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[hsl(var(--fg-muted))]" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email, company…"
          className="pl-9"
          aria-label="Search leads"
        />
      </div>
      <Select
        aria-label="Filter by status"
        defaultValue={params.get("status") ?? ""}
        onChange={(e) => push({ status: e.target.value || null })}
        className="w-auto"
      >
        <option value="">All statuses</option>
        {LEAD_STATUSES.map((s) => (
          <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>
        ))}
      </Select>
      <Select
        aria-label="Filter by owner"
        defaultValue={params.get("owner") ?? ""}
        onChange={(e) => push({ owner: e.target.value || null })}
        className="w-auto"
      >
        <option value="">Anyone</option>
        {members.map((m) => (
          <option key={m.user_id} value={m.user_id}>{m.label}</option>
        ))}
      </Select>
      <Select
        aria-label="Sort by"
        defaultValue={params.get("sort") ?? "created_desc"}
        onChange={(e) => push({ sort: e.target.value })}
        className="w-auto"
      >
        <option value="created_desc">Newest first</option>
        <option value="created_asc">Oldest first</option>
        <option value="value_desc">Highest value</option>
        <option value="score_desc">Best AI score</option>
        <option value="name_asc">Name A–Z</option>
        <option value="followup_asc">Next follow-up</option>
      </Select>
      <button
        type="button"
        onClick={() => router.push("/leads")}
        className="inline-flex items-center gap-1 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs font-medium hover:bg-[hsl(var(--muted))]"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" /> Reset
      </button>
    </div>
  );
}
