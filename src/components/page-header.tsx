import * as React from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-[hsl(var(--fg-muted))]">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn";
}) {
  const color =
    tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "";
  return (
    <div className="rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-[hsl(var(--fg-muted))]">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${color}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-[hsl(var(--fg-muted))]">{hint}</p> : null}
    </div>
  );
}

/** Dependency-free bar chart — real values, no chart library, no fake curves. */
export function BarChart({ data, height = 140 }: { data: { label: string; value: number; tone?: string }[]; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.map((d) => (
        <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <span className="text-[10px] font-medium text-[hsl(var(--fg-muted))]">{d.value}</span>
          <div
            className="w-full rounded-t bg-brand-500/90"
            style={{ height: `${Math.max(2, (d.value / max) * (height - 34))}px` }}
            title={`${d.label}: ${d.value}`}
          />
          <span className="w-full truncate text-center text-[10px] text-[hsl(var(--fg-muted))]">{d.label}</span>
        </div>
      ))}
    </div>
  );
}
