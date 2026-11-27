"use client";

import { useActionState, useState } from "react";
import { Check, Crown, Save, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  approvePlatformClaimAction,
  grantFoundingMemberAction,
  rejectPlatformClaimAction,
  revokeFoundingMemberAction,
  savePlatformSettingsAction,
  submitPlatformClaimAction,
  type PlatformPaymentState,
} from "@/lib/actions/platform-payments";
import { LOCAL_METHOD_LABEL, type BillingCycle, type LocalMethodKind } from "@/lib/local-payments";
import type { PlatformSettings } from "@/lib/platform-payments";

const METHOD_KINDS: LocalMethodKind[] = ["sadapay", "jazzcash", "easypaisa", "bank"];

/**
 * Platform owner's payout configuration.
 *
 * Every number is typed here by the owner — nothing is hardcoded in the codebase, so
 * changing a wallet is a form submission rather than a release. `demo_mode` is
 * deliberately last and labelled, because it turns a real approval into an automatic
 * one and must never be left on by accident.
 */
export function PlatformSettingsForm({ settings }: { settings: PlatformSettings }) {
  const [state, action, pending] = useActionState(savePlatformSettingsAction, null as PlatformPaymentState);

  return (
    <form action={action} className="space-y-4">
      {state?.error ? <Alert tone="danger" title="Not saved">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="account_holder_name">Account holder name</Label>
          <Input id="account_holder_name" name="account_holder_name" defaultValue={settings.account_holder_name ?? ""} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="default_method">Default method</Label>
          <Select id="default_method" name="default_method" defaultValue={settings.default_method}>
            {METHOD_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {LOCAL_METHOD_LABEL[kind]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="sadapay_number">SadaPay number</Label>
          <Input id="sadapay_number" name="sadapay_number" defaultValue={settings.sadapay_number ?? ""} placeholder="03XXXXXXXXX" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="jazzcash_number">JazzCash number</Label>
          <Input id="jazzcash_number" name="jazzcash_number" defaultValue={settings.jazzcash_number ?? ""} placeholder="03XXXXXXXXX" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="easypaisa_number">EasyPaisa number</Label>
          <Input id="easypaisa_number" name="easypaisa_number" defaultValue={settings.easypaisa_number ?? ""} placeholder="03XXXXXXXXX" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="bank_name">Bank name</Label>
          <Input id="bank_name" name="bank_name" defaultValue={settings.bank_name ?? ""} placeholder="e.g. Meezan Bank" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="bank_iban">Bank IBAN</Label>
          <Input id="bank_iban" name="bank_iban" defaultValue={settings.bank_iban ?? ""} placeholder="PK00XXXX0000000000000000" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="instructions">Instructions shown to the customer</Label>
          <Textarea
            id="instructions"
            name="instructions"
            defaultValue={settings.instructions ?? ""}
            placeholder="Send the exact amount, then enter the transaction ID below."
          />
        </div>
      </div>

      <div className="grid gap-4 rounded-lg border border-[hsl(var(--border))] p-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="founding_member_price">Founding price (Rs / month)</Label>
          <Input
            id="founding_member_price"
            name="founding_member_price"
            inputMode="numeric"
            defaultValue={Math.round(settings.founding_member_price_cents / 100)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="founding_member_slots">Founding slots</Label>
          <Input id="founding_member_slots" name="founding_member_slots" inputMode="numeric" defaultValue={settings.founding_member_slots} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="founding_member_member_limit">Seats per Founding workspace</Label>
          <Input
            id="founding_member_member_limit"
            name="founding_member_member_limit"
            inputMode="numeric"
            defaultValue={settings.founding_member_member_limit}
          />
        </div>
      </div>

      <label htmlFor="demo_mode" className="flex items-start gap-2 rounded-lg border border-[hsl(var(--border))] p-3 text-sm">
        <input id="demo_mode" name="demo_mode" type="checkbox" defaultChecked={settings.demo_mode === 1} className="mt-1" />
        <span>
          <strong>Demo mode</strong> — the platform owner&apos;s own claim is approved automatically (still flagged
          self-approved in the audit trail). For testing only; leave off for real customers.
        </span>
      </label>

      <Button type="submit" disabled={pending}>
        <Save className="h-4 w-4" /> {pending ? "Saving…" : "Save payout settings"}
      </Button>
    </form>
  );
}

/** Approve / reject one claim. Rejection requires a reason the customer will read. */
export function ReviewClaimForm({ claimId, amountPkr }: { claimId: string; amountPkr: number }) {
  const [approveState, approveAction, approving] = useActionState(approvePlatformClaimAction, null as PlatformPaymentState);
  const [rejectState, rejectAction, rejecting] = useActionState(rejectPlatformClaimAction, null as PlatformPaymentState);
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-2">
      {approveState?.error ? <Alert tone="danger">{approveState.error}</Alert> : null}
      {approveState?.notice ? <Alert tone="success">{approveState.notice}</Alert> : null}
      {rejectState?.error ? <Alert tone="warning">{rejectState.error}</Alert> : null}
      {rejectState?.notice ? <Alert tone="warning">{rejectState.notice}</Alert> : null}

      <form action={approveAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="claim_id" value={claimId} />
        <Input name="review_note" placeholder="Note (optional)" className="h-9 max-w-[220px]" />
        <Button type="submit" size="sm" disabled={approving}>
          <Check className="h-4 w-4" /> {approving ? "Approving…" : `Approve Rs ${amountPkr.toLocaleString()}`}
        </Button>
      </form>

      <form action={rejectAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="claim_id" value={claimId} />
        <Input
          name="review_note"
          required
          minLength={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Reason (the customer sees this)"
          className="h-9 max-w-[260px]"
        />
        <Button type="submit" size="sm" variant="outline" disabled={rejecting}>
          <X className="h-4 w-4" /> {rejecting ? "Rejecting…" : "Reject"}
        </Button>
      </form>
    </div>
  );
}

/**
 * Customer-side claim form.
 *
 * The amount is shown, not stored: the server recomputes it from the plan and any
 * locked Founding price, so editing the page cannot change what is owed.
 */
export function SubmitPlatformClaimForm({
  plans,
  defaultMethod,
  methods,
  openClaimPlan,
}: {
  plans: { code: string; name: string; monthlyPkr: number; annualPkr: number }[];
  defaultMethod: LocalMethodKind;
  methods: { kind: LocalMethodKind; label: string }[];
  openClaimPlan: string | null;
}) {
  const [state, action, pending] = useActionState(submitPlatformClaimAction, null as PlatformPaymentState);
  const [planCode, setPlanCode] = useState(openClaimPlan ?? plans[0]?.code ?? "starter");
  const [cycle, setCycle] = useState<BillingCycle>("monthly");

  const selected = plans.find((plan) => plan.code === planCode);
  const amount = selected ? (cycle === "annual" ? selected.annualPkr : selected.monthlyPkr) : 0;

  if (methods.length === 0) {
    return (
      <Alert tone="warning" title="No platform payout method configured">
        The platform owner has not added a wallet or IBAN yet, so there is nowhere to send money. Try again once the
        owner has configured payouts.
      </Alert>
    );
  }

  return (
    <form action={action} className="space-y-3">
      {state?.error ? <Alert tone="danger" title="Not submitted">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="plan_code">Plan</Label>
          <Select id="plan_code" name="plan_code" value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="billing_cycle">Billing cycle</Label>
          <Select
            id="billing_cycle"
            name="billing_cycle"
            value={cycle}
            onChange={(event) => setCycle(event.target.value as BillingCycle)}
          >
            <option value="monthly">Monthly</option>
            <option value="annual">Annual</option>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="method_kind">You paid with</Label>
          <Select id="method_kind" name="method_kind" defaultValue={defaultMethod}>
            {methods.map((method) => (
              <option key={method.kind} value={method.kind}>
                {method.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="reference">Transaction ID</Label>
          <Input id="reference" name="reference" required minLength={3} maxLength={80} placeholder="From your wallet SMS/receipt" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="note">Note (optional)</Label>
          <Input id="note" name="note" maxLength={500} placeholder="Anything the owner should know" />
        </div>
      </div>

      <p className="text-sm text-[hsl(var(--fg-muted))]">
        You will be asked for <strong>Rs {amount.toLocaleString()}</strong> for the {selected?.name ?? planCode} plan
        ({cycle}). The exact amount is calculated by the server — it is not editable here.
      </p>

      <Button type="submit" disabled={pending}>
        <Send className="h-4 w-4" /> {pending ? "Submitting…" : "Submit payment for approval"}
      </Button>
    </form>
  );
}

/** Manual Founding Member grant/revoke on a workspace record (super-admin only). */
export function FoundingMemberControls({ organizationId, isMember }: { organizationId: string; isMember: boolean }) {
  const [state, action, pending] = useActionState(
    isMember ? revokeFoundingMemberAction : grantFoundingMemberAction,
    null as PlatformPaymentState
  );
  const [reason, setReason] = useState("");

  return (
    <form action={action} className="space-y-2">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      <input type="hidden" name="organization_id" value={organizationId} />
      <p className="flex items-center gap-2 text-sm">
        <Crown className="h-4 w-4" />
        {isMember ? "Founding Member — price is locked." : "Not a Founding Member."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="note"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={isMember ? "Reason for revoking (audited)" : "Why is this granted manually? (audited)"}
          className="h-9 max-w-[280px]"
          required={isMember}
        />
        <Button type="submit" size="sm" variant={isMember ? "outline" : "default"} disabled={pending}>
          <Crown className="h-4 w-4" />
          {pending ? "Saving…" : isMember ? "Revoke Founding Member" : "Grant Founding Member"}
        </Button>
      </div>
      <p className="text-xs text-[hsl(var(--fg-muted))]">
        Grant only after the money has actually arrived. Revoking deletes the locked price; re-granting locks today&apos;s
        price, not the original.
      </p>
    </form>
  );
}
