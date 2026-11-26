"use client";

import { useActionState } from "react";
import { FlaskConical, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Label, Select } from "@/components/ui/input";
import {
  testAutomationAction, retryExecutionAction,
  deleteAutomationAction, toggleAutomationAction, type AutomationState,
} from "@/lib/actions/automations";


export function TestAutomationForm({ automationId, leads }: { automationId: string; leads: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(testAutomationAction, null as AutomationState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="automation_id" value={automationId} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`sample-${automationId}`}>Sample lead</Label>
          <Select id={`sample-${automationId}`} name="sample_lead_id" defaultValue="" className="w-auto">
            <option value="">Synthetic sample</option>
            {leads.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          <FlaskConical className="h-4 w-4" /> {pending ? "Testing…" : "Test run"}
        </Button>
      </div>
      {state?.error ? <Alert tone="danger">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="info">{state.notice}</Alert> : null}
      {state?.log && state.log.length > 0 ? (
        <ol className="ml-4 list-decimal space-y-1 text-xs text-[hsl(var(--fg-muted))]">
          {state.log.map((l, i) => (
            <li key={i}>
              <span className="font-medium">{l.action}</span> — {l.status}: {l.detail}
            </li>
          ))}
        </ol>
      ) : null}
    </form>
  );
}

export function RetryButton({ executionId }: { executionId: string }) {
  const [state, action, pending] = useActionState(retryExecutionAction, null as AutomationState);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="execution_id" value={executionId} />
      <Button type="submit" size="sm" variant="ghost" disabled={pending} title={state?.notice ?? "Retry this run"}>
        <RotateCcw className="h-3.5 w-3.5" /> {pending ? "…" : "Retry"}
      </Button>
      {state?.notice ? <span className="ml-1 text-xs text-[hsl(var(--fg-muted))]">{state.notice}</span> : null}
    </form>
  );
}

export function AutomationRowActions({ automationId, active }: { automationId: string; active: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <form action={toggleAutomationAction}>
        <input type="hidden" name="automation_id" value={automationId} />
        <Button type="submit" size="sm" variant="outline">{active ? "Deactivate" : "Activate"}</Button>
      </form>
      <form action={deleteAutomationAction}>
        <input type="hidden" name="automation_id" value={automationId} />
        <Button type="submit" size="icon" variant="ghost" aria-label="Delete automation"><Trash2 className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}
