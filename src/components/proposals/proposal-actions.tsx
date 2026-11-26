"use client";

import { useActionState, useState } from "react";
import { Check, Copy, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { sendProposalAction, setProposalStatusAction, type ProposalState } from "@/lib/actions/proposals";

export function SendProposalButton({ proposalId }: { proposalId: string }) {
  const [state, action, pending] = useActionState(sendProposalAction, null as ProposalState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="proposal_id" value={proposalId} />
      <Button type="submit" size="sm" disabled={pending}>
        <Send className="h-4 w-4" /> {pending ? "Working…" : "Mark as sent"}
      </Button>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
    </form>
  );
}

export function StatusButtons({ proposalId, status }: { proposalId: string; status: string }) {
  const [state, action, pending] = useActionState(setProposalStatusAction, null as ProposalState);
  if (status === "accepted" || status === "rejected") {
    return (
      <p className="text-xs text-[hsl(var(--fg-muted))]">
        The client set this status from the share link. Staff cannot override it.
      </p>
    );
  }
  return (
    <form action={action} className="flex flex-wrap gap-2">
      <input type="hidden" name="proposal_id" value={proposalId} />
      {status !== "draft" ? (
        <Button type="submit" name="status" value="draft" size="sm" variant="outline" disabled={pending}>Back to draft</Button>
      ) : null}
      {status !== "expired" ? (
        <Button type="submit" name="status" value="expired" size="sm" variant="outline" disabled={pending}>Mark expired</Button>
      ) : null}
      {state?.error ? <span className="text-xs text-red-600">{state.error}</span> : null}
    </form>
  );
}

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copied ? "Copied" : "Copy link"}
    </Button>
  );
}
