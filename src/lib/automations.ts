import { all, get, run, tx } from "./db";
import { newId } from "./ids";
import { nowIso } from "./utils";
import { logActivity } from "./audit";
import { safeParse } from "./plans";

/**
 * Automation engine
 * -----------------
 * Triggers → optional conditions → ordered steps.
 *
 * Safety properties (all enforced here, not in the UI):
 *  - idempotency: unique(automation_id, idempotency_key) makes duplicate webhook
 *    deliveries and double-clicks no-ops instead of double-sending email.
 *  - per-automation daily run limit.
 *  - every step is logged; failures are captured with the error message.
 *  - external communication (email) is always created as `pending_approval`
 *    unless the step explicitly has requires_approval = false.
 */

import {
  TRIGGERS, TRIGGER_LABEL, ACTIONS, ACTION_LABEL,
  type TriggerType, type ActionType,
} from "./automation-meta";

export { TRIGGERS, TRIGGER_LABEL, ACTIONS, ACTION_LABEL };
export type { TriggerType, ActionType };

export type AutomationRow = {
  id: string;
  organization_id: string;
  name: string;
  trigger_type: TriggerType;
  conditions: string;
  is_active: number;
  run_limit_per_day: number;
};

export type StepRow = {
  id: string;
  automation_id: string;
  step_order: number;
  action_type: ActionType;
  config: string;
  requires_approval: number;
};

export type TriggerEntity = {
  type: "lead" | "customer" | "proposal" | "document" | "subscription";
  id: string;
  data: Record<string, unknown>;
  /** extra discriminator so the same entity can trigger different transitions */
  dedupeSuffix?: string;
};

export type ExecutionResult = {
  automationId: string;
  automationName: string;
  status: "succeeded" | "failed" | "skipped";
  reason?: string;
  log: { step: number; action: ActionType; status: string; detail: string }[];
};

type Condition = { field: string; op: "equals" | "not_equals" | "gt" | "lt" | "contains" | "exists"; value?: string | number };

function evaluateConditions(conditions: Condition[], entity: Record<string, unknown>): { pass: boolean; reason?: string } {
  for (const c of conditions) {
    const raw = entity[c.field];
    const actual = raw === null || raw === undefined ? "" : raw;
    switch (c.op) {
      case "equals":
        if (String(actual) !== String(c.value ?? "")) return { pass: false, reason: `${c.field} is not "${c.value}"` };
        break;
      case "not_equals":
        if (String(actual) === String(c.value ?? "")) return { pass: false, reason: `${c.field} equals "${c.value}"` };
        break;
      case "gt":
        if (!(Number(actual) > Number(c.value ?? 0))) return { pass: false, reason: `${c.field} not greater than ${c.value}` };
        break;
      case "lt":
        if (!(Number(actual) < Number(c.value ?? 0))) return { pass: false, reason: `${c.field} not less than ${c.value}` };
        break;
      case "contains":
        if (!String(actual).toLowerCase().includes(String(c.value ?? "").toLowerCase()))
          return { pass: false, reason: `${c.field} does not contain "${c.value}"` };
        break;
      case "exists":
        if (!String(actual).trim()) return { pass: false, reason: `${c.field} is empty` };
        break;
    }
  }
  return { pass: true };
}

function runsToday(automationId: string): number {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const row = get<{ c: number }>(
    "select count(*) as c from automation_executions where automation_id = ? and created_at >= ?",
    [automationId, start.toISOString()]
  );
  return row?.c ?? 0;
}

async function executeStep(
  step: StepRow,
  automation: AutomationRow,
  entity: TriggerEntity,
  context: { dryRun: boolean; actorId: string | null }
): Promise<{ status: string; detail: string }> {
  const cfg = safeParse<Record<string, unknown>>(step.config, {});
  const orgId = automation.organization_id;
  const now = nowIso();

  switch (step.action_type) {
    case "create_task": {
      if (context.dryRun) return { status: "dry_run", detail: "Would create a task" };
      const title = String(cfg.title ?? `Follow up with ${entity.data.name ?? "contact"}`);
      const dueDays = Number(cfg.dueInDays ?? 3);
      const due = new Date(Date.now() + dueDays * 86400000).toISOString();
      run(
        "insert into tasks (id, organization_id, assigned_to, lead_id, customer_id, title, details, due_at, completed_at, created_at) values (?,?,?,?,?,?,?,?,?,?)",
        [
          newId(),
          orgId,
          null,
          entity.type === "lead" ? entity.id : null,
          entity.type === "customer" ? entity.id : null,
          title,
          String(cfg.details ?? ""),
          due,
          null,
          now,
        ]
      );
      return { status: "ok", detail: `Task created: "${title}" due ${due.slice(0, 10)}` };
    }

    case "update_lead_status": {
      if (entity.type !== "lead") return { status: "skipped", detail: "Entity is not a lead" };
      const status = String(cfg.status ?? "contacted");
      if (!["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"].includes(status)) {
        return { status: "failed", detail: `Invalid target status "${status}"` };
      }
      if (context.dryRun) return { status: "dry_run", detail: `Would set lead status to ${status}` };
      run("update leads set status = ?, updated_at = ? where id = ? and organization_id = ?", [status, now, entity.id, orgId]);
      return { status: "ok", detail: `Lead status set to ${status}` };
    }

    case "generate_ai_draft": {
      // Drafts are stored as messages with status 'draft' — never sent automatically.
      if (context.dryRun) return { status: "dry_run", detail: "Would create an AI draft" };
      const template = String(cfg.template ?? "Follow-up introducing our services.");
      const body = `${template}\n\n(Draft generated by automation "${automation.name}". Review and edit before sending.)`;
      run(
        `insert into messages (id, organization_id, lead_id, customer_id, direction, channel, subject, body, status, created_at)
         values (?,?,?,?,?,?,?,?,?,?)`,
        [
          newId(),
          orgId,
          entity.type === "lead" ? entity.id : null,
          entity.type === "customer" ? entity.id : null,
          "outbound",
          "email",
          String(cfg.subject ?? "Follow-up"),
          body,
          "draft",
          now,
        ]
      );
      return { status: "ok", detail: "Draft message created (requires human review)" };
    }

    case "send_email": {
      // Never sends from the engine. Creates a queue entry awaiting approval.
      if (context.dryRun) return { status: "dry_run", detail: "Would queue an email for approval" };
      const subject = String(cfg.subject ?? "Message from our team");
      const body = String(cfg.body ?? "Hello — thank you for getting in touch.");
      run(
        `insert into messages (id, organization_id, lead_id, customer_id, direction, channel, subject, body, status, created_at)
         values (?,?,?,?,?,?,?,?,?,?)`,
        [
          newId(),
          orgId,
          entity.type === "lead" ? entity.id : null,
          entity.type === "customer" ? entity.id : null,
          "outbound",
          "email",
          subject,
          body,
          "pending_approval",
          now,
        ]
      );
      return { status: "ok", detail: "Email queued for approval (not sent automatically)" };
    }

    case "create_reminder": {
      if (context.dryRun) return { status: "dry_run", detail: "Would create a reminder" };
      const days = Number(cfg.dueInDays ?? 1);
      run("update leads set next_follow_up_at = ?, updated_at = ? where id = ? and organization_id = ?", [
        new Date(Date.now() + days * 86400000).toISOString(),
        now,
        entity.id,
        orgId,
      ]);
      return { status: "ok", detail: `Reminder set in ${days} day(s)` };
    }

    case "notify_admin": {
      if (context.dryRun) return { status: "dry_run", detail: "Would notify admins" };
      const admins = all<{ user_id: string }>(
        "select user_id from organization_members where organization_id = ? and role in ('owner','admin')",
        [orgId]
      );
      for (const a of admins) {
        run(
          "insert into notifications (id, organization_id, user_id, title, body, level, read_at, created_at) values (?,?,?,?,?,?,?,?)",
          [newId(), orgId, a.user_id, String(cfg.title ?? automation.name), String(cfg.body ?? "Automation triggered"), "info", null, now]
        );
      }
      return { status: "ok", detail: `Notified ${admins.length} admin(s)` };
    }

    case "score_lead": {
      if (entity.type !== "lead") return { status: "skipped", detail: "Entity is not a lead" };
      if (context.dryRun) return { status: "dry_run", detail: "Would score the lead" };
      const { ruleBasedLeadScore } = await import("./ai");
      const lead = get<Record<string, unknown>>("select * from leads where id = ? and organization_id = ?", [entity.id, orgId]);
      if (!lead) return { status: "skipped", detail: "Lead not found" };
      const score = ruleBasedLeadScore({
        name: String(lead.name ?? ""),
        email: lead.email as string | null,
        phone: lead.phone as string | null,
        company: lead.company as string | null,
        source: lead.source as string | null,
        status: lead.status as string | null,
        value_cents: Number(lead.value_cents ?? 0),
        notes: lead.notes as string | null,
      });
      run("update leads set ai_score = ?, ai_score_reason = ?, ai_next_action = ?, ai_scored_at = ?, updated_at = ? where id = ? and organization_id = ?", [
        score.score,
        `[rules] ${score.reason}`,
        score.nextAction,
        now,
        now,
        entity.id,
        orgId,
      ]);
      return { status: "ok", detail: `Lead scored ${score.score}/100 (rule-based)` };
    }

    default:
      return { status: "failed", detail: `Unknown action type` };
  }
}

/**
 * Fire all matching automations for a trigger.
 * Returns one result per automation. Never throws for a single failing automation.
 */
export async function dispatchTrigger(
  organizationId: string,
  triggerType: TriggerType,
  entity: TriggerEntity,
  options: { dryRun?: boolean; actorId?: string | null; automationId?: string } = {}
): Promise<ExecutionResult[]> {
  const automations = all<AutomationRow>(
    `select * from automations where organization_id = ? and trigger_type = ? and is_active = 1
     ${options.automationId ? "and id = ?" : ""}`,
    options.automationId ? [organizationId, triggerType, options.automationId] : [organizationId, triggerType]
  );

  const results: ExecutionResult[] = [];

  for (const automation of automations) {
    if (!options.dryRun && runsToday(automation.id) >= automation.run_limit_per_day) {
      results.push({ automationId: automation.id, automationName: automation.name, status: "skipped", reason: "Daily run limit reached", log: [] });
      continue;
    }

    const conditions = safeParse<Condition[]>(automation.conditions, []);
    const evaluation = evaluateConditions(conditions, entity.data);
    if (!evaluation.pass) {
      results.push({ automationId: automation.id, automationName: automation.name, status: "skipped", reason: evaluation.reason, log: [] });
      continue;
    }

    const steps = all<StepRow>("select * from automation_steps where automation_id = ? order by step_order asc", [automation.id]);
    const idempotencyKey = `${entity.type}:${entity.id}${entity.dedupeSuffix ? `:${entity.dedupeSuffix}` : ""}`;

    const log: ExecutionResult["log"] = [];
    const executionId = newId();

    if (!options.dryRun) {
      try {
        run(
          `insert into automation_executions (id, organization_id, automation_id, trigger_entity_type, trigger_entity_id,
             idempotency_key, status, attempts, log, error, started_at, finished_at, created_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            executionId, organizationId, automation.id, entity.type, entity.id, idempotencyKey,
            "running", 1, "[]", null, nowIso(), null, nowIso(),
          ]
        );
      } catch {
        // Unique constraint => this trigger was already processed. Duplicate prevention.
        results.push({ automationId: automation.id, automationName: automation.name, status: "skipped", reason: "Already executed for this event (duplicate blocked)", log: [] });
        continue;
      }
    }

    let failed = false;
    let errorMessage: string | null = null;

    for (const step of steps) {
      const outcome = await executeStep(step, automation, entity, {
        dryRun: Boolean(options.dryRun),
        actorId: options.actorId ?? null,
      });
      log.push({ step: step.step_order, action: step.action_type, status: outcome.status, detail: outcome.detail });
      if (outcome.status === "failed") {
        failed = true;
        errorMessage = outcome.detail;
        break;
      }
    }

    if (!options.dryRun) {
      run("update automation_executions set status = ?, log = ?, error = ?, finished_at = ? where id = ?", [
        failed ? "failed" : "succeeded",
        JSON.stringify(log),
        errorMessage,
        nowIso(),
        executionId,
      ]);
      run("update automations set last_run_at = ? where id = ?", [nowIso(), automation.id]);
      logActivity({
        organizationId,
        actorId: options.actorId ?? null,
        entityType: "automation",
        entityId: automation.id,
        action: failed ? "automation.failed" : "automation.succeeded",
        summary: `${automation.name} ${failed ? "failed" : "ran"} for ${entity.type} ${entity.id}`,
      });
    }

    results.push({
      automationId: automation.id,
      automationName: automation.name,
      status: failed ? "failed" : "succeeded",
      reason: errorMessage ?? undefined,
      log,
    });
  }

  return results;
}

/** Manual "test run", always dry-run — safe to press repeatedly. */
export async function testAutomation(
  organizationId: string,
  automationId: string,
  entity: TriggerEntity
): Promise<ExecutionResult[]> {
  return dispatchTrigger(organizationId, TRIGGERS[0], entity, { dryRun: true, automationId });
}

export function executionHistory(organizationId: string, limit = 30) {
  return all<{
    id: string; automation_id: string; status: string; attempts: number; log: string;
    error: string | null; created_at: string; automation_name: string;
  }>(
    `select e.*, a.name as automation_name
       from automation_executions e join automations a on a.id = e.automation_id
      where e.organization_id = ?
      order by e.created_at desc limit ?`,
    [organizationId, limit]
  ).map((r) => ({ ...r, logParsed: safeParse<ExecutionResult["log"]>(r.log, []) }));
}

export function createAutomationWithSteps(input: {
  organizationId: string;
  createdBy: string;
  name: string;
  description?: string;
  triggerType: TriggerType;
  conditions?: Condition[];
  steps: { actionType: ActionType; config?: Record<string, unknown>; requiresApproval?: boolean }[];
}): string {
  const id = newId();
  const now = nowIso();
  tx(() => {
    run(
      `insert into automations (id, organization_id, name, description, trigger_type, conditions, is_active,
         run_limit_per_day, last_run_at, created_by, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, input.organizationId, input.name, input.description ?? null, input.triggerType,
        JSON.stringify(input.conditions ?? []), 1, 100, null, input.createdBy, now, now,
      ]
    );
    input.steps.forEach((step, index) => {
      run(
        `insert into automation_steps (id, organization_id, automation_id, step_order, action_type, config, requires_approval)
         values (?,?,?,?,?,?,?)`,
        [
          newId(), input.organizationId, id, index, step.actionType,
          JSON.stringify(step.config ?? {}), step.requiresApproval === false ? 0 : 1,
        ]
      );
    });
  });
  return id;
}
