"use client";

import { useActionState, useState } from "react";
import { BadgeCheck, Banknote, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  saveLocalMethodAction,
  submitLocalPaymentAction,
  toggleLocalMethodAction,
  deleteLocalMethodAction,
  reviewLocalPaymentAction,
  refundLocalPaymentAction,
  type LocalPaymentState,
} from "@/lib/actions/local-payments";
import { LOCAL_METHOD_HINT, LOCAL_METHOD_KINDS, LOCAL_METHOD_LABEL, type LocalMethodKind } from "@/lib/local-payments";

type Method = { id: string; kind: string; label: string | null; account_number: string; is_active: number };

/** Owner/admin: add or edit the account customers pay into. */
export function LocalMethodForm({ existing }: { existing?: { id: string; kind: string; label: string | null; account_title: string; account_number: string; payment_link: string | null; instructions: string | null } }) {
  const [state, action, pending] = useActionState(saveLocalMethodAction, null as LocalPaymentState);
  const [kind, setKind] = useState<LocalMethodKind>((existing?.kind as LocalMethodKind) ?? "sadapay");
  const hint = LOCAL_METHOD_HINT[kind];

  return (
    <form action={action} className="space-y-3">
      {existing ? <input type="hidden" name="method_id" value={existing.id} /> : null}
      {state?.error ? <Alert tone="danger" title="Not saved">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <div className="space-y-1.5">
        <Label htmlFor="kind">Method</Label>
        <Select id="kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value as LocalMethodKind)}>
          {LOCAL_METHOD_KINDS.map((k) => (
            <option key={k} value={k}>{LOCAL_METHOD_LABEL[k]}</option>
          ))}
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="account_title">Account title *</Label>
        <Input id="account_title" name="account_title" defaultValue={existing?.account_title ?? ""} placeholder={hint.accountTitle} required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="account_number">Account / wallet number *</Label>
        <Input id="account_number" name="account_number" defaultValue={existing?.account_number ?? ""} placeholder={hint.accountNumber} required />
        <p className="text-xs text-[hsl(var(--fg-muted))]">
          {kind === "bank" ? "Pakistani IBAN (24 characters) or an 8–20 digit account number." : "11 digits starting 03 — the number you actually receive money on."}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="label">Label (optional)</Label>
        <Input id="label" name="label" defaultValue={existing?.label ?? ""} placeholder="e.g. SadaPay — Shahab" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="payment_link">Payment link (optional)</Label>
        <Input id="payment_link" name="payment_link" defaultValue={existing?.payment_link ?? ""} placeholder="https://sadapay.pk/…" />
        <p className="text-xs text-[hsl(var(--fg-muted))]">If your wallet gives you a pay link or QR, paste it here and it is shown to the customer.</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="instructions">Instructions for the customer (optional)</Label>
        <Textarea id="instructions" name="instructions" rows={2} defaultValue={existing?.instructions ?? ""} placeholder="Send the exact amount, then submit the transaction ID below." />
      </div>

      <Button type="submit" disabled={pending}>
        <Save className="h-4 w-4" /> {pending ? "Saving…" : existing ? "Save changes" : "Add payment method"}
      </Button>
    </form>
  );
}

export function ToggleMethodButton({ method }: { method: Method }) {
  return (
    <form action={toggleLocalMethodAction}>
      <input type="hidden" name="method_id" value={method.id} />
      <Button type="submit" size="sm" variant="ghost">{method.is_active ? "Disable" : "Enable"}</Button>
    </form>
  );
}

export function DeleteMethodButton({ method }: { method: Method }) {
  return (
    <form action={deleteLocalMethodAction}>
      <input type="hidden" name="method_id" value={method.id} />
      <Button type="submit" size="sm" variant="ghost" aria-label={`Delete ${LOCAL_METHOD_LABEL[(method.kind as LocalMethodKind) ?? "other"] ?? "method"}`}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </form>
  );
}

/** Anyone with billing rights: "I sent Rs X, reference Y". */
export function SubmitPaymentForm({
  methods,
  plans,
  amounts,
}: {
  methods: Method[];
  plans: { code: string; name: string }[];
  amounts: Record<string, { monthly: number; annual: number }>;
}) {
  const [state, action, pending] = useActionState(submitLocalPaymentAction, null as LocalPaymentState);
  const [plan, setPlan] = useState(plans[0]?.code ?? "");
  const [cycle, setCycle] = useState<"monthly" | "annual">("monthly");
  const suggested = amounts[plan]?.[cycle] ?? 0;

  return (
    <form action={action} className="space-y-3">
      {state?.error ? <Alert tone="danger" title="Not submitted">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="plan_code">Plan</Label>
          <Select id="plan_code" name="plan_code" value={plan} onChange={(e) => setPlan(e.target.value)}>
            {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="billing_cycle">Billing cycle</Label>
          <Select id="billing_cycle" name="billing_cycle" value={cycle} onChange={(e) => setCycle(e.target.value as "monthly" | "annual")}>
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="method_id">Paid to</Label>
        <Select id="method_id" name="method_id">
          {methods.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label || LOCAL_METHOD_LABEL[(m.kind as LocalMethodKind) ?? "other"]} · {m.account_number}
            </option>
          ))}
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="amount_pkr">Amount sent (Rs) *</Label>
        <Input id="amount_pkr" name="amount_pkr" inputMode="numeric" defaultValue={suggested ? String(suggested) : ""} key={`${plan}-${cycle}`} required />
        <p className="text-xs text-[hsl(var(--fg-muted))]">
          {suggested ? `Suggested: Rs ${suggested.toLocaleString()} — send the exact amount if you can.` : "Enter the amount you actually transferred."}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reference">Transaction ID / reference *</Label>
        <Input id="reference" name="reference" placeholder="e.g. 12345678901 or the last digits of your SadaPay transfer" required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="payer_note">Note (optional)</Label>
        <Textarea id="payer_note" name="payer_note" rows={2} placeholder="Anything the approver should know." />
      </div>

      <Button type="submit" disabled={pending || methods.length === 0}>
        <Banknote className="h-4 w-4" /> {pending ? "Submitting…" : "I have sent this payment"}
      </Button>
    </form>
  );
}

export function ReviewPaymentButtons({ requestId }: { requestId: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <form action={reviewLocalPaymentAction}>
        <input type="hidden" name="request_id" value={requestId} />
        <input type="hidden" name="decision" value="approve" />
        <Button type="submit" size="sm">
          <BadgeCheck className="h-4 w-4" /> Approve & activate
        </Button>
      </form>
      <form action={reviewLocalPaymentAction}>
        <input type="hidden" name="request_id" value={requestId} />
        <input type="hidden" name="decision" value="reject" />
        <Button type="submit" size="sm" variant="outline">Not received</Button>
      </form>
    </div>
  );
}

/**
 * Owner/admin: record money going back to the customer.
 *
 * Deliberately a form and not a one-click button: a refund without an amount and a
 * reason is unreviewable six months later, and "who gave this back and why" is the
 * first question anyone asks.
 */
export function RefundPaymentForm({ requestId, paidPkr, remainingPkr }: { requestId: string; paidPkr: number; remainingPkr: number }) {
  const [state, action, pending] = useActionState(refundLocalPaymentAction, null as LocalPaymentState);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <RotateCcw className="h-4 w-4" /> Refund
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="request_id" value={requestId} />
      {state?.error ? <Alert tone="danger" title="Not refunded">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      <div className="space-y-1">
        <Label htmlFor={`refund_pkr_${requestId}`}>Refund amount (PKR)</Label>
        <Input
          id={`refund_pkr_${requestId}`}
          name="refund_pkr"
          type="number"
          min={1}
          step="0.01"
          defaultValue={remainingPkr}
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`refund_reason_${requestId}`}>Reason</Label>
        <Input
          id={`refund_reason_${requestId}`}
          name="refund_reason"
          placeholder={`Paid Rs ${paidPkr.toLocaleString()} — why is it going back?`}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={pending}>
          {pending ? "Recording…" : "Record refund"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
