"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select } from "@/components/ui/input";
import { updatePlanAction, suspendOrganizationAction, setOrganizationPlanAction, type AdminState } from "@/lib/actions/admin";

function Feedback({ state }: { state: AdminState }) {
  if (!state) return null;
  if (state.error) return <Alert tone="danger">{state.error}</Alert>;
  if (state.notice) return <Alert tone="success">{state.notice}</Alert>;
  return null;
}

export function PlanEditor({ plan }: { plan: {
  code: string; name: string; price_monthly_cents: number; price_annual_cents: number;
  lead_limit: number; member_limit: number; ai_generation_limit: number;
  automation_limit: number; document_limit: number; features: string;
} }) {
  const [state, action, pending] = useActionState(updatePlanAction, null as AdminState);
  return (
    <form action={action} className="space-y-2 rounded-xl border border-[hsl(var(--border))] p-3">
      <Feedback state={state} />
      <input type="hidden" name="code" value={plan.code} />
      <p className="text-sm font-semibold capitalize">{plan.code}</p>
      <div className="grid grid-cols-2 gap-2">
        <Field name="name" label="Name" defaultValue={plan.name} />
        <Field name="price_monthly_cents" label="Monthly (cents)" defaultValue={String(plan.price_monthly_cents)} type="number" />
        <Field name="price_annual_cents" label="Annual (cents)" defaultValue={String(plan.price_annual_cents)} type="number" />
        <Field name="lead_limit" label="Lead limit" defaultValue={String(plan.lead_limit)} type="number" />
        <Field name="member_limit" label="Members" defaultValue={String(plan.member_limit)} type="number" />
        <Field name="ai_generation_limit" label="AI / month" defaultValue={String(plan.ai_generation_limit)} type="number" />
        <Field name="automation_limit" label="Automations" defaultValue={String(plan.automation_limit)} type="number" />
        <Field name="document_limit" label="Documents" defaultValue={String(plan.document_limit)} type="number" />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`features-${plan.code}`}>Features JSON</Label>
        <Input id={`features-${plan.code}`} name="features" defaultValue={plan.features} className="font-mono text-xs" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save plan"}</Button>
    </form>
  );
}

export function OrgActions({ orgId, suspended, planCode, plans }: { orgId: string; suspended: boolean; planCode: string; plans: { code: string; name: string }[] }) {
  const [suspendState, suspendAction, suspending] = useActionState(suspendOrganizationAction, null as AdminState);
  const [planState, planAction, planPending] = useActionState(setOrganizationPlanAction, null as AdminState);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={planAction} className="flex items-center gap-1">
        <input type="hidden" name="organization_id" value={orgId} />
        <Select name="plan_code" defaultValue={planCode} className="h-8 w-auto text-xs" aria-label="Assign plan">
          {plans.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
        </Select>
        <Button type="submit" size="sm" variant="ghost" disabled={planPending}>Assign</Button>
      </form>
      <form action={suspendAction}>
        <input type="hidden" name="organization_id" value={orgId} />
        <Button type="submit" size="sm" variant={suspended ? "outline" : "danger"} disabled={suspending}>
          {suspended ? "Restore" : "Suspend"}
        </Button>
      </form>
      {suspendState?.notice ? <span className="text-xs text-emerald-600">{suspendState.notice}</span> : null}
      {planState?.notice ? <span className="text-xs text-emerald-600">{planState.notice}</span> : null}
      {suspendState?.error ? <span className="text-xs text-red-600">{suspendState.error}</span> : null}
      {planState?.error ? <span className="text-xs text-red-600">{planState.error}</span> : null}
    </div>
  );
}

function Field({ name, label, defaultValue, type = "text" }: { name: string; label: string; defaultValue: string; type?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={`${name}-field`} className="text-xs">{label}</Label>
      <Input id={`${name}-field`} name={name} type={type} defaultValue={defaultValue} className="h-8 text-xs" />
    </div>
  );
}
