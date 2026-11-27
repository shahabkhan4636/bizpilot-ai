"use client";

import { useActionState, useMemo, useState } from "react";
import { Plus, Trash2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { createAutomationAction, type AutomationState } from "@/lib/actions/automations";
import { TRIGGERS, TRIGGER_LABEL, ACTIONS, ACTION_LABEL, type ActionType } from "@/lib/automation-meta";
import { AI_KINDS, AI_KIND_LABEL } from "@/lib/ai";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/csv";

type Condition = { field: string; op: string; value: string };
type Step = { action: ActionType | ""; config: Record<string, string> };

const CONDITION_FIELDS = [
  { value: "status", label: "Lead status" },
  { value: "source", label: "Source" },
  { value: "value_cents", label: "Estimated value (cents)" },
  { value: "company", label: "Company" },
  { value: "email", label: "Email" },
  { value: "name", label: "Name" },
  { value: "notes", label: "Notes" },
];

const OPS = [
  { value: "equals", label: "is" },
  { value: "not_equals", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "gt", label: "is greater than" },
  { value: "lt", label: "is less than" },
  { value: "exists", label: "is present" },
];

const emptyCondition: Condition = { field: "status", op: "equals", value: "new" };
const emptyStep: Step = { action: "", config: {} };

/** Per-action configuration fields, so nobody has to hand-write JSON. */
function ActionConfig({
  action,
  config,
  onChange,
}: {
  action: ActionType;
  config: Record<string, string>;
  onChange: (patch: Record<string, string>) => void;
}) {
  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    onChange({ [key]: e.target.value });

  switch (action) {
    case "create_task":
    case "create_reminder":
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Task title</Label>
            <Input value={config.title ?? ""} onChange={set("title")} placeholder="Call the new lead" aria-label="Task title" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Due in (days)</Label>
            <Input value={config.due_in_days ?? "1"} onChange={set("due_in_days")} type="number" min={0} aria-label="Due in (days)" className="h-8 text-xs" />
          </div>
        </div>
      );
    case "update_lead_status":
      return (
        <div className="space-y-1">
          <Label className="text-xs">Set status to</Label>
          <Select value={config.status ?? "contacted"} onChange={set("status")} aria-label="Set status to" className="h-8 text-xs">
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
      );
    case "generate_ai_draft":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Draft type</Label>
            <Select value={config.kind ?? "follow_up"} onChange={set("kind")} aria-label="Draft type" className="h-8 text-xs">
              {AI_KINDS.map((k) => <option key={k} value={k}>{AI_KIND_LABEL[k]}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Tone</Label>
            <Input value={config.tone ?? "professional"} onChange={set("tone")} aria-label="Tone" className="h-8 text-xs" />
          </div>
        </div>
      );
    case "send_email":
      return (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs">Subject</Label>
            <Input value={config.subject ?? ""} onChange={set("subject")} placeholder="Thanks for getting in touch" aria-label="Subject" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Body</Label>
            <Textarea value={config.body ?? ""} onChange={set("body")} rows={3} aria-label="Body" className="min-h-[60px] text-xs" placeholder="Hi, thanks for reaching out…" />
          </div>
          <p className="text-xs text-[hsl(var(--fg-muted))]">Email steps are always queued as pending approval — the engine never sends without a human.</p>
        </div>
      );
    case "notify_admin":
      return (
        <div className="space-y-1">
          <Label className="text-xs">Notification text</Label>
          <Input value={config.message ?? ""} onChange={set("message")} placeholder="A high-value lead just arrived" aria-label="Notification text" className="h-8 text-xs" />
        </div>
      );
    case "score_lead":
      return <p className="text-xs text-[hsl(var(--fg-muted))]">Scores the lead with the AI provider, or the rule-based model when no key is set.</p>;
    default:
      return null;
  }
}

export function AutomationBuilder({ leadCount }: { leadCount: number }) {
  const [state, action, pending] = useActionState(createAutomationAction, null as AutomationState);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [trigger, setTrigger] = useState<string>("lead.created");
  const [runLimit, setRunLimit] = useState("100");
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [steps, setSteps] = useState<Step[]>([{ action: "create_task", config: { title: "Follow up on the new lead", due_in_days: "1" } }]);

  const summary = useMemo(() => {
    const when = TRIGGER_LABEL[trigger as keyof typeof TRIGGER_LABEL] ?? trigger;
    const ifPart = conditions.length
      ? ` · only when ${conditions.map((c) => `${c.field} ${OPS.find((o) => o.value === c.op)?.label ?? c.op} ${c.value}`).join(" and ")}`
      : "";
    const then = steps.filter((s) => s.action).map((s) => ACTION_LABEL[s.action as ActionType]);
    return `When: ${when}${ifPart} → ${then.length ? then.join(", then ") : "no steps yet"}`;
  }, [trigger, conditions, steps]);

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> New automation
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold"><Workflow className="h-4 w-4 text-brand-600" /> Build an automation</h2>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>

      {state?.error ? <Alert tone="danger" title="Could not create">{state.error}</Alert> : null}
      {state?.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name *</Label>
          <Input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={3} placeholder="Welcome new website leads" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="description">Description</Label>
          <Input id="description" name="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this automation is for" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="trigger_type">Trigger *</Label>
          <Select id="trigger_type" name="trigger_type" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            {TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
          </Select>
        </div>
        {trigger === "schedule.tick" ? (
          <div className="space-y-1.5">
            <Label htmlFor="schedule_interval_minutes">Run every (minutes) *</Label>
            <Input
              id="schedule_interval_minutes"
              name="schedule_interval_minutes"
              type="number"
              min={5}
              max={43200}
              defaultValue={60}
            />
            <p className="text-xs text-[hsl(var(--fg-muted))]">
              The scheduler runs every 10 minutes; anything under that waits for the next tick.
            </p>
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor="run_limit_per_day">Max runs per day</Label>
          <Input id="run_limit_per_day" name="run_limit_per_day" type="number" min={1} max={5000} value={runLimit} onChange={(e) => setRunLimit(e.target.value)} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Conditions (all must match)</Label>
          <Button type="button" size="sm" variant="outline" onClick={() => setConditions((p) => [...p, { ...emptyCondition }])}>
            <Plus className="h-3.5 w-3.5" /> Add condition
          </Button>
        </div>
        {conditions.length === 0 ? (
          <p className="text-xs text-[hsl(var(--fg-muted))]">No conditions — this runs on every trigger.</p>
        ) : (
          conditions.map((c, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <Select
                className="col-span-4"
                value={c.field}
                aria-label={`Condition ${i + 1} field`}
                onChange={(e) => setConditions((p) => p.map((x, idx) => (idx === i ? { ...x, field: e.target.value } : x)))}
              >
                {CONDITION_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </Select>
              <Select
                className="col-span-3"
                value={c.op}
                aria-label={`Condition ${i + 1} operator`}
                onChange={(e) => setConditions((p) => p.map((x, idx) => (idx === i ? { ...x, op: e.target.value } : x)))}
              >
                {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              <Input
                className="col-span-4"
                value={c.value}
                aria-label={`Condition ${i + 1} value`}
                placeholder="value"
                onChange={(e) => setConditions((p) => p.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))}
              />
              <div className="col-span-1 flex items-center">
                <Button type="button" size="icon" variant="ghost" aria-label="Remove condition" onClick={() => setConditions((p) => p.filter((_, idx) => idx !== i))}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Steps (run in order)</Label>
          <Button type="button" size="sm" variant="outline" onClick={() => setSteps((p) => [...p, { ...emptyStep }])}>
            <Plus className="h-3.5 w-3.5" /> Add step
          </Button>
        </div>
        {steps.map((s, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-[hsl(var(--border))] p-2.5">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[hsl(var(--muted))] text-xs font-semibold">{i + 1}</span>
              <Select
                value={s.action}
                aria-label={`Step ${i + 1} action`}
                onChange={(e) =>
                  setSteps((p) => p.map((x, idx) => (idx === i ? { action: e.target.value as ActionType, config: {} } : x)))
                }
                className="h-8 text-xs"
              >
                <option value="">Choose an action…</option>
                {ACTIONS.map((a) => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}
              </Select>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Remove step"
                onClick={() => setSteps((p) => (p.length > 1 ? p.filter((_, idx) => idx !== i) : p))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {s.action ? (
              <ActionConfig
                action={s.action}
                config={s.config}
                onChange={(patch) => setSteps((p) => p.map((x, idx) => (idx === i ? { ...x, config: { ...x.config, ...patch } } : x)))}
              />
            ) : null}
          </div>
        ))}
      </div>

      <Alert tone="info" title="Preview">{summary}</Alert>

      <input type="hidden" name="conditions_json" value={JSON.stringify(conditions)} />
      <input
        type="hidden"
        name="steps_json"
        value={JSON.stringify(
          steps
            .filter((s) => s.action)
            .map((s) => ({ action: s.action, config: Object.fromEntries(Object.entries(s.config).filter(([, v]) => String(v).trim() !== "")) }))
        )}
      />

      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create automation"}</Button>
      <p className="text-xs text-[hsl(var(--fg-muted))]">
        {leadCount > 0
          ? "Use “Test run” on the created automation to see the step log without sending anything."
          : "Create a lead first if you want to test this against a real record."}
      </p>
    </form>
  );
}
