"use client";

import { useActionState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Textarea } from "@/components/ui/input";
import { acceptProposalAction, declineProposalAction, type ProposalState } from "@/lib/actions/proposals";

export function AcceptProposalForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptProposalAction, null as ProposalState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success" title="Recorded">{state.notice}</Alert> : null}
      <div className="space-y-1.5">
        <Label htmlFor="accepted_by">Your name</Label>
        <Input id="accepted_by" name="accepted_by" required placeholder="Sara Ahmed" />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        <CheckCircle2 className="h-4 w-4" /> {pending ? "Recording…" : "Accept this proposal"}
      </Button>
    </form>
  );
}

export function DeclineProposalForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(declineProposalAction, null as ProposalState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success" title="Recorded">{state.notice}</Alert> : null}
      <div className="space-y-1.5">
        <Label htmlFor="reason">Reason (optional)</Label>
        <Textarea id="reason" name="reason" rows={2} className="min-h-[60px]" placeholder="Budget, timing, scope…" />
      </div>
      <Button type="submit" variant="outline" className="w-full" disabled={pending}>
        <XCircle className="h-4 w-4" /> {pending ? "Recording…" : "Decline"}
      </Button>
    </form>
  );
}
