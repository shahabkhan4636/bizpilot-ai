import * as React from "react";
import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  danger: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/60 dark:text-red-200",
  success: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
};

export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: keyof typeof tones;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cn("rounded-lg border p-4 text-sm", tones[tone], className)}>
      {title ? <p className="mb-1 font-semibold">{title}</p> : null}
      {children ? <div className="opacity-90">{children}</div> : null}
    </div>
  );
}
