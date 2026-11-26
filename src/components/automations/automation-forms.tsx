"use client";

import { useActionState, useState } from "react";
import { FlaskConical, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select } from "@/components/ui/input";
import {
  createAutomationAction, testAutomationAction, retryExecutionAction,
  deleteAutomationAction, toggleAutomationAction, type AutomationState,
} from "@/lib/actions/automations";
import { TRIGGERS, TRIGGER_LABEL, ACTIONS, ACTION_LABEL } from "@/lib/automation-meta";

const CONDITION_FIELDS = ["status", "source", "value_cents", "company", "email", "name"];
const OPS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "gt", label: "greater than" },
  { value: "lt", label: "less than" },
  { value: "exists", label: "is present" },
];

export function NewAutomationPanel() {
  const [state, action, pending] = useActionState(createAutomationAction, null as AutomationState);
  const [open, setOpen] = useState(false);

  if (!open) return <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New automation</Button>;

  return (
    <form action={action} className="space-y-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Build an automation</h2>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {state?.error ? <Alert tone="danger" title="Could not create">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name *</Label>
          <Input id="name" name="name" required placeholder="Welcome new website leads" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="trigger_type">Trigger *</Label>
          <Select id="trigger_type" name="trigger_type" defaultValue="lead.created">
            {TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Input id="description" name="description" placeholder="What this automation is for" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="run_limit_per_day">Max runs per day</Label>
          <Input id="run_limit_per_day" name="run_limit_per_day" type="number" min={1} max={5000} defaultValue={100} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Conditions (all must match)</p>
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Select className="col-span-4" name="condition_field" defaultValue={i === 0 ? "" : ""} aria-label={`Condition ${i + 1} field`}>
              <option value="">No condition</option>
              {CONDITION_FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
            </Select>
            <Select className="col-span-4" name="condition_op" defaultValue="equals" aria-label={`Condition ${i + 1} operator`}>
              {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Input className="col-span-4" name="condition_value" placeholder="value" aria-label={`Condition ${i + 1} value`} />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Steps (run in order)</p>
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <Select className="col-span-6" name="step_action" aria-label={`Step ${i + 1} action`}>
              <option value="">No step</option>
              {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
            </Select>
            <Input className="col-span-6" name="step_config" placeholder='config JSON, e.g. {"title":"Call the lead"}' aria-label={`Step ${i + 1} config`} />
          </div>
        ))}
        <p className="text-xs text-[hsl(var(--fg-muted))]">Email steps always require approval — the engine queues them as pending approval.</p>
      </div>

      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create automation"}</Button>
    </form>
  );
}

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
