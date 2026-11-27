"use client";

import { useActionState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label } from "@/components/ui/input";
import { sendTestEmailAction, type AdminState } from "@/lib/actions/admin";

/**
 * Test-send form.
 *
 * Defaults to the signed-in owner's address so the common case is one click, and
 * says plainly when the deployment cannot send — the message is queued either way,
 * never silently dropped.
 */
export function TestEmailForm({ defaultTo, configured }: { defaultTo: string; configured: boolean }) {
  const [state, action, pending] = useActionState(sendTestEmailAction, null as AdminState);

  return (
    <form action={action} className="space-y-3">
      {state?.error ? <Alert tone="danger" title="Not sent">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}
      <div className="space-y-1">
        <Label htmlFor="test_email_to">Send to</Label>
        <Input id="test_email_to" name="to" type="email" defaultValue={defaultTo} required />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        <Send className="h-4 w-4" /> {pending ? "Sending…" : configured ? "Send test email" : "Queue test email"}
      </Button>
      {!configured ? (
        <p className="text-xs text-[hsl(var(--fg-muted))]">
          Without <code>RESEND_API_KEY</code> the message is stored in the outbox, not delivered.
        </p>
      ) : null}
    </form>
  );
}
