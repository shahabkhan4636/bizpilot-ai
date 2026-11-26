"use client";

import { useActionState, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createProposalAction, updateProposalAction, type ProposalState } from "@/lib/actions/proposals";
import { formatMoney } from "@/lib/utils";

type Line = { description: string; quantity: string; price: string };
type Item = { description: string; quantity: number; unit_price_cents: number };

export function ProposalEditor({
  mode,
  proposal,
  items,
  taxPercent,
  currency,
  discountPercent: propsDiscountPercent,
  discountCents: propsDiscountCents,
  clientName,
  clientEmail,
  customerId,
  leadId,
  customers,
  leads,
}: {
  mode: "create" | "edit";
  proposal?: { id: string; title: string; summary: string | null; scope: string | null; terms: string | null };
  items: Item[];
  taxPercent: number;
  currency: string;
  discountPercent?: number;
  discountCents?: number;
  clientName: string;
  clientEmail: string;
  customerId?: string | null;
  leadId?: string | null;
  customers: { id: string; name: string }[];
  leads: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(
    mode === "create" ? createProposalAction : updateProposalAction,
    null as ProposalState
  );
  const [lines, setLines] = useState<Line[]>(
    items.length
      ? items.map((i) => ({ description: i.description, quantity: String(i.quantity), price: (i.unit_price_cents / 100).toFixed(2) }))
      : [{ description: "", quantity: "1", price: "0.00" }]
  );
  const [tax, setTax] = useState(String(taxPercent));
  const [curr, setCurr] = useState(currency);
  const [discountPercent, setDiscountPercent] = useState(String(propsDiscountPercent ?? 0));
  const [discountAmount, setDiscountAmount] = useState(((propsDiscountCents ?? 0) / 100).toFixed(2));
  const [shareDays, setShareDays] = useState("30");
  const [selectedCustomer, setSelectedCustomer] = useState(customerId ?? "");
  const [selectedLead, setSelectedLead] = useState(leadId ?? "");

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, l) => {
      const q = Number(l.quantity) || 0;
      const p = Number(l.price) || 0;
      return sum + Math.round(q * p * 100);
    }, 0);
    const taxCents = Math.round((subtotal * (Number(tax) || 0)) / 100);
    return { subtotal, taxCents, total: subtotal + taxCents };
  }, [lines, tax]);

  function update(index: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  return (
    <form action={action} className="space-y-5">
      {state?.error ? <Alert tone="danger" title="Could not save">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      {mode === "edit" && proposal ? <input type="hidden" name="proposal_id" value={proposal.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="title">Proposal title *</Label>
          <Input id="title" name="title" required minLength={3} defaultValue={proposal?.title ?? ""} placeholder="Website redesign — phase 1" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="client_name">Client name *</Label>
          <Input id="client_name" name="client_name" required defaultValue={clientName} placeholder="Vertex Interiors" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="client_email">Client email</Label>
          <Input id="client_email" name="client_email" type="email" defaultValue={clientEmail} placeholder="hello@vertex.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="currency">Currency</Label>
          <Select id="currency" name="currency" value={curr} onChange={(e) => setCurr(e.target.value)}>
            {["USD", "PKR", "GBP", "EUR", "AED", "CAD", "AUD", "INR"].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tax_percent">Tax rate (%)</Label>
          <Input id="tax_percent" name="tax_percent" value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="discount_percent">Discount (%)</Label>
          <Input
            id="discount_percent"
            name="discount_percent"
            value={discountPercent}
            onChange={(e) => setDiscountPercent(e.target.value)}
            inputMode="decimal"
            placeholder="0"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="discount_amount">Discount (fixed)</Label>
          <Input
            id="discount_amount"
            name="discount_amount"
            value={discountAmount}
            onChange={(e) => setDiscountAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="share_expiry_days">Share link valid for (days)</Label>
          <Input
            id="share_expiry_days"
            name="share_expiry_days"
            value={shareDays}
            onChange={(e) => setShareDays(e.target.value)}
            inputMode="numeric"
            placeholder="30"
          />
          <p className="text-xs text-[hsl(var(--fg-muted))]">Blank or 0 keeps the link valid until the proposal expires.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="customer_id">Link to customer</Label>
          <Select id="customer_id" name="customer_id" value={selectedCustomer} onChange={(e) => setSelectedCustomer(e.target.value)}>
            <option value="">No customer</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lead_id">Link to lead</Label>
          <Select id="lead_id" name="lead_id" value={selectedLead} onChange={(e) => setSelectedLead(e.target.value)}>
            <option value="">No lead</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Line items</Label>
          <Button type="button" size="sm" variant="outline" onClick={() => setLines((p) => [...p, { description: "", quantity: "1", price: "0.00" }])}>
            <Plus className="h-3.5 w-3.5" /> Add line
          </Button>
        </div>
        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <Input
                className="col-span-6"
                name="item_description"
                value={line.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="Description of work"
                aria-label={`Line ${i + 1} description`}
              />
              <Input
                className="col-span-2"
                name="item_quantity"
                value={line.quantity}
                onChange={(e) => update(i, { quantity: e.target.value })}
                inputMode="decimal"
                aria-label={`Line ${i + 1} quantity`}
              />
              <Input
                className="col-span-2"
                name="item_price"
                value={line.price}
                onChange={(e) => update(i, { price: e.target.value })}
                inputMode="decimal"
                aria-label={`Line ${i + 1} unit price`}
              />
              <div className="col-span-2 flex items-center justify-end gap-1 text-sm">
                <span className="tabular-nums">{formatMoney(Math.round((Number(line.quantity) || 0) * (Number(line.price) || 0) * 100), curr)}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove line"
                  onClick={() => setLines((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : p))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div className="ml-auto w-full max-w-xs space-y-1 border-t border-[hsl(var(--border))] pt-2 text-sm">
          <div className="flex justify-between"><span className="text-[hsl(var(--fg-muted))]">Subtotal</span><span className="tabular-nums">{formatMoney(totals.subtotal, curr)}</span></div>
          <div className="flex justify-between"><span className="text-[hsl(var(--fg-muted))]">Tax</span><span className="tabular-nums">{formatMoney(totals.taxCents, curr)}</span></div>
          <div className="flex justify-between font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(totals.total, curr)}</span></div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="summary">Summary</Label>
          <Textarea id="summary" name="summary" defaultValue={proposal?.summary ?? ""} placeholder="One paragraph the client reads first." />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="scope">Scope of work</Label>
          <Textarea id="scope" name="scope" defaultValue={proposal?.scope ?? ""} placeholder="Deliverables, timeline, assumptions." className="min-h-[120px]" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="terms">Terms</Label>
          <Textarea id="terms" name="terms" defaultValue={proposal?.terms ?? ""} placeholder="Payment schedule, validity, cancellation." />
        </div>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : mode === "create" ? "Create proposal" : "Save as new version"}
      </Button>
      <p className="text-xs text-[hsl(var(--fg-muted))]">
        Totals are recalculated on the server — the preview above is only a convenience.
      </p>
    </form>
  );
}
