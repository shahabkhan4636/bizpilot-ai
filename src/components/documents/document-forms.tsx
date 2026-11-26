"use client";

import { useActionState, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Label, Select } from "@/components/ui/input";
import { uploadDocumentAction, deleteDocumentAction, type DocumentState } from "@/lib/actions/documents";

export function UploadDocumentForm({ customers }: { customers: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(uploadDocumentAction, null as DocumentState);
  const [name, setName] = useState<string | null>(null);

  return (
    <form action={action} className="space-y-3">
      {state?.error ? <Alert tone="danger" title="Upload failed">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      <div className="space-y-1.5">
        <Label htmlFor="file">File (max 10 MB)</Label>
        <input
          id="file"
          name="file"
          type="file"
          required
          onChange={(e) => setName(e.target.files?.[0]?.name ?? null)}
          className="block w-full cursor-pointer rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-2 text-sm"
        />
        {name ? <p className="text-xs text-[hsl(var(--fg-muted))]">{name}</p> : null}
        <p className="text-xs text-[hsl(var(--fg-muted))]">PDF, images, CSV, text, Word and Excel files.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="customer_id">Attach to customer (optional)</Label>
        <Select id="customer_id" name="customer_id" defaultValue="">
          <option value="">No customer</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </div>
      <Button type="submit" disabled={pending}>
        <Upload className="h-4 w-4" /> {pending ? "Uploading…" : "Upload file"}
      </Button>
    </form>
  );
}

export function DeleteDocumentButton({ documentId }: { documentId: string }) {
  return (
    <form action={deleteDocumentAction}>
      <input type="hidden" name="document_id" value={documentId} />
      <Button type="submit" size="sm" variant="ghost">Delete</Button>
    </form>
  );
}
