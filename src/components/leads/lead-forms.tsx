"use client";

import { useActionState, useState } from "react";
import { Bot, Plus, StickyNote, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import {
  createLeadAction, updateLeadAction, addNoteAction, scoreLeadAction, assignLeadAction,
  type LeadState,
} from "@/lib/actions/leads";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/csv";

function Feedback({ state }: { state: LeadState }) {
  if (!state) return null;
  if (state.error) return <Alert tone="danger" title="Could not save">{state.error}</Alert>;
  if (state.notice) return <Alert tone="success">{state.notice}</Alert>;
  return null;
}

export function NewLeadPanel({ members, defaultOpen = false }: { members: { user_id: string; label: string }[]; defaultOpen?: boolean }) {
  const [state, action, pending] = useActionState(createLeadAction, null);
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm">
        <Plus className="h-4 w-4" /> New lead
      </Button>
    );
  }

  return (
    <form action={action} className="w-full space-y-4 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--surface))] p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Add a lead</h2>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      <Feedback state={state} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="name">Name *</Label>
          <Input id="name" name="name" required minLength={2} placeholder="Sara Ahmed" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="sara@company.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" placeholder="+92 300 1234567" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="company">Company</Label>
          <Input id="company" name="company" placeholder="Vertex Interiors" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="source">Source</Label>
          <Select id="source" name="source" defaultValue="manual">
            {["manual", "website", "referral", "public_form", "ad", "cold_outreach", "import"].map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <Select id="status" name="status" defaultValue="new">
            {LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="value">Estimated value</Label>
          <Input id="value" name="value" inputMode="decimal" placeholder="1500.00" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="next_follow_up_at">Follow-up date</Label>
          <Input id="next_follow_up_at" name="next_follow_up_at" type="date" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="assigned_to">Assign to</Label>
          <Select id="assigned_to" name="assigned_to" defaultValue="">
            <option value="">Me</option>
            {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="notes">Notes</Label>
          <Textarea id="notes" name="notes" placeholder="What did they ask for?" />
        </div>
      </div>
      <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create lead"}</Button>
    </form>
  );
}

export function UpdateLeadForm({ leadId, status, value, followUp }: { leadId: string; status: string; value: string; followUp: string }) {
  const [state, action, pending] = useActionState(updateLeadAction, null);
  return (
    <form action={action} className="space-y-3">
      <Feedback state={state} />
      <input type="hidden" name="lead_id" value={leadId} />
      <div className="space-y-1.5">
        <Label htmlFor="status">Pipeline status</Label>
        <Select id="status" name="status" defaultValue={status}>
          {LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="value">Estimated value</Label>
        <Input id="value" name="value" defaultValue={value} inputMode="decimal" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="next_follow_up_at">Next follow-up</Label>
        <Input id="next_follow_up_at" name="next_follow_up_at" type="date" defaultValue={followUp} />
      </div>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save changes"}</Button>
    </form>
  );
}

export function ScoreLeadButton({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(scoreLeadAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="lead_id" value={leadId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <Bot className="h-4 w-4" /> {pending ? "Scoring…" : "Score this lead"}
      </Button>
      <Feedback state={state} />
    </form>
  );
}

export function NoteForm({ leadId }: { leadId: string }) {
  const [state, action, pending] = useActionState(addNoteAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="lead_id" value={leadId} />
      <Textarea name="body" required placeholder="Add a note about this conversation…" aria-label="Note" />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          <StickyNote className="h-4 w-4" /> {pending ? "Adding…" : "Add note"}
        </Button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function AssignForm({ leadId, members, current }: { leadId: string; members: { user_id: string; label: string }[]; current: string | null }) {
  const [state, action, pending] = useActionState(assignLeadAction, null);
  return (
    <form action={action} className="flex items-end gap-2">
      <input type="hidden" name="lead_id" value={leadId} />
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="assigned_to">Owner</Label>
        <Select id="assigned_to" name="assigned_to" defaultValue={current ?? ""}>
          <option value="">Unassigned</option>
          {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.label}</option>)}
        </Select>
      </div>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        <UserCog className="h-4 w-4" /> {pending ? "…" : "Set"}
      </Button>
      {state?.error ? <span className="text-xs text-red-600">{state.error}</span> : null}
    </form>
  );
}
