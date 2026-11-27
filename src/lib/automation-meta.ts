/**
 * Trigger and action catalogues. Kept in a dependency-free module so client
 * components can render the builder without pulling server-only code
 * (node:fs / node:crypto) into the browser bundle.
 */

export const TRIGGERS = [
  "lead.created",
  "lead.status_changed",
  "customer.created",
  "proposal.accepted",
  "proposal.rejected",
  "followup.overdue",
  "document.uploaded",
  "subscription.payment_succeeded",
  "subscription.payment_failed",
  // Fired by the cron runner (/api/cron/automations), not by a user action.
  "schedule.tick",
] as const;
export type TriggerType = (typeof TRIGGERS)[number];

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  "lead.created": "New lead submitted",
  "lead.status_changed": "Lead status changed",
  "customer.created": "New customer created",
  "proposal.accepted": "Proposal accepted",
  "proposal.rejected": "Proposal declined",
  "followup.overdue": "Follow-up overdue",
  "document.uploaded": "Document uploaded",
  "subscription.payment_succeeded": "Subscription payment succeeded",
  "subscription.payment_failed": "Subscription payment failed",
  "schedule.tick": "On a schedule (every N minutes)",
};

/** Trigger types driven by the scheduler rather than by an event in the app. */
export const SCHEDULED_TRIGGERS: readonly TriggerType[] = ["schedule.tick", "followup.overdue"];

export const ACTIONS = [
  "create_task",
  "update_lead_status",
  "generate_ai_draft",
  "send_email",
  "create_reminder",
  "notify_admin",
  "score_lead",
] as const;
export type ActionType = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<ActionType, string> = {
  create_task: "Create a task",
  update_lead_status: "Update lead status",
  generate_ai_draft: "Generate AI content draft",
  send_email: "Send email (requires approval)",
  create_reminder: "Create a reminder",
  notify_admin: "Notify workspace admins",
  score_lead: "Score the lead",
};
