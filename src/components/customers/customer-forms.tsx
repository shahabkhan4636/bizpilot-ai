"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Textarea } from "@/components/ui/input";
import { createCustomerAction, updateCustomerAction, type CustomerState } from "@/lib/actions/customers";

function Feedback({ state }: { state: CustomerState }) {
  if (!state) return null;
  if (state.error) return <Alert tone="danger" title="Could not save">{state.error}</Alert>;
  if (state.notice) return <Alert tone="success">{state.notice}</Alert>;
  return null;
}

const fields = [
  { name: "name", label: "Name", placeholder: "Vertex Interiors", required: true },
  { name: "email", label: "Email", placeholder: "hello@vertex.com", type: "email" },
  { name: "phone", label: "Phone", placeholder: "+92 300 1234567" },
  { name: "company", label: "Company", placeholder: "Vertex Interiors" },
  { name: "address", label: "Address", placeholder: "Street, city, country" },
];

export function NewCustomerPanel() {
  const [state, action, pending] = useActionState(createCustomerAction, null);
  const [open, setOpen] = useState(false);

  if (!open) return <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New customer</Button>;

  return (
    <form action={action} className="w-full space-y-3 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Add a customer</h2>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <Feedback state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={f.name === "address" ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label htmlFor={f.name}>{f.label}{f.required ? " *" : ""}</Label>
            <Input id={f.name} name={f.name} type={f.type ?? "text"} required={f.required} placeholder={f.placeholder} />
          </div>
        ))}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" placeholder="Preferences, billing notes…" />
        </div>
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create customer"}</Button>
    </form>
  );
}

export function EditCustomerForm({
  customer,
}: {
  customer: { id: string; name: string; email: string | null; phone: string | null; company: string | null; address: string | null; notes: string | null };
}) {
  const [state, action, pending] = useActionState(updateCustomerAction, null);
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <input type="hidden" name="customer_id" value={customer.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <div key={f.name} className={f.name === "address" ? "space-y-1.5 sm:col-span-2" : "space-y-1.5"}>
            <Label htmlFor={`e-${f.name}`}>{f.label}</Label>
            <Input
              id={`e-${f.name}`}
              name={f.name}
              type={f.type ?? "text"}
              required={f.required}
              defaultValue={(customer as unknown as Record<string, string | null>)[f.name] ?? ""}
            />
          </div>
        ))}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="e-notes">Notes</Label>
          <Textarea id="e-notes" name="notes" defaultValue={customer.notes ?? ""} />
        </div>
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save customer"}</Button>
    </form>
  );
}
