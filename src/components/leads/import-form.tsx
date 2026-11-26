"use client";

import { useActionState, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Label, Textarea } from "@/components/ui/input";
import { importLeadsAction } from "@/lib/actions/leads";

export function ImportForm() {
  const [state, action, pending] = useActionState(importLeadsAction, null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setFileName("File is larger than 5 MB — split it into smaller files.");
      return;
    }
    setFileName(file.name);
    setCsv(await file.text());
  }

  const preview = csv.split(/\r?\n/).filter(Boolean).slice(0, 5);

  return (
    <form action={action} className="space-y-4">
      {state?.error ? <Alert tone="danger" title="Import failed">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success" title="Import finished">{state.notice}</Alert> : null}

      <div className="space-y-1.5">
        <Label htmlFor="file">CSV file</Label>
        <input
          id="file"
          type="file"
          accept=".csv,text/csv"
          onChange={onFile}
          className="block w-full cursor-pointer rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-2 text-sm"
        />
        {fileName ? <p className="text-xs text-[hsl(var(--fg-muted))]">{fileName}</p> : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="csv">Or paste CSV content</Label>
        <Textarea
          id="csv"
          name="csv"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={10}
          className="min-h-[180px] font-mono text-xs"
          placeholder={"name,email,phone,company,source,status,value,notes\nSara Ahmed,sara@vertex.com,+923001234567,Vertex Interiors,referral,qualified,2500,Met at expo"}
        />
      </div>

      {preview.length > 0 ? (
        <div className="rounded-lg border border-[hsl(var(--border))] p-3">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-[hsl(var(--fg-muted))]">Preview (first 5 lines)</p>
          <pre className="overflow-x-auto text-xs">{preview.join("\n")}</pre>
        </div>
      ) : null}

      <Button type="submit" disabled={pending || !csv.trim()}>
        <Upload className="h-4 w-4" /> {pending ? "Importing…" : "Import leads"}
      </Button>
    </form>
  );
}
