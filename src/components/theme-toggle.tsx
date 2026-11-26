"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/** Applied in <head> before paint to avoid a flash of the wrong theme. */
export function ThemeScript() {
  const code = `(function(){try{var t=localStorage.getItem('bizpilot-theme');var m=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(!t&&m)){document.documentElement.classList.add('dark');}}catch(e){}})();`;
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("bizpilot-theme", next ? "dark" : "light");
    } catch {
      /* storage blocked */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[hsl(var(--border))] text-[hsl(var(--fg-muted))] transition-colors hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--fg))] ${className}`}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
