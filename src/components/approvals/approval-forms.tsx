"use client";

import { useActionState } from "react";
import { Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { approveQueuedMessageAction, rejectQueuedMessageAction, type ApprovalState } from "@/lib/actions/approvals";

export function ApproveMessageForm({ messageId }: { messageId: string }) {
  const [state, action, pending] = useActionState(approveQueuedMessageAction, null as ApprovalState);
  return (
    <form action={action} className="space-y-2">
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      <input type="hidden" name="message_id" value={messageId} />
      <label className="flex items-start gap-2 text-xs text-[hsl(var(--fg-muted))]">
        <input type="checkbox" name="approved" className="mt-0.5" />
        I have read this message and approve sending it to the recipient.
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        <Send className="h-3.5 w-3.5" /> {pending ? "Sending…" : "Approve & send"}
      </Button>
    </form>
  );
}

export function RejectMessageButton({ messageId }: { messageId: string }) {
  return (
    <form action={rejectQueuedMessageAction}>
      <input type="hidden" name="message_id" value={messageId} />
      <Button type="submit" size="sm" variant="ghost">
        <X className="h-3.5 w-3.5" /> Reject
      </Button>
    </form>
  );
}
