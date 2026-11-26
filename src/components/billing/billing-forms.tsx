"use client";

import { useActionState } from "react";
import { CreditCard, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { startCheckoutAction, openPortalAction, cancelSubscriptionAction, type BillingState } from "@/lib/actions/billing";

export function CheckoutButton({ planCode, cycle, label }: { planCode: string; cycle: "monthly" | "annual"; label: string }) {
  const [state, action, pending] = useActionState(startCheckoutAction, null as BillingState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="plan_code" value={planCode} />
      <input type="hidden" name="cycle" value={cycle} />
      <Button type="submit" className="w-full" variant={cycle === "annual" ? "outline" : "default"} disabled={pending}>
        <CreditCard className="h-4 w-4" /> {pending ? "Opening…" : label}
      </Button>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
    </form>
  );
}

export function PortalButton({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState(openPortalAction, null as BillingState);
  return (
    <form action={action} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending || disabled}>
        <ExternalLink className="h-4 w-4" /> {pending ? "Opening…" : "Open billing portal"}
      </Button>
      {state?.error ? <Alert tone="warning">{state.error}</Alert> : null}
    </form>
  );
}

export function CancelForm() {
  const [state, action, pending] = useActionState(cancelSubscriptionAction, null as BillingState);
  return (
    <form action={action} className="space-y-2">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="warning">{state.notice}</Alert> : null}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirm" className="mt-0.5 h-4 w-4" />
        <span>I understand this drops the workspace to Starter limits immediately.</span>
      </label>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>{pending ? "Cancelling…" : "Cancel subscription"}</Button>
    </form>
  );
}
