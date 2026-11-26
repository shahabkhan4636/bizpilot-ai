"use server";

import { revalidatePath } from "next/cache";
import { run, get, all } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { audit, logActivity } from "@/lib/audit";
import { checkAutomationLimit } from "@/lib/plans";
import { ValidationError, str, optionalStr, oneOf } from "@/lib/validate";
import { dispatchTrigger, testAutomation, type TriggerEntity } from "@/lib/automations";
import { TRIGGERS, ACTIONS, type TriggerType, type ActionType } from "@/lib/automation-meta";
import { createAutomationWithSteps } from "@/lib/automations";

export type AutomationState = {
  error?: string;
  notice?: string;
  log?: { step: number; action: string; status: string; detail: string }[];
  results?: { name: string; status: string; reason?: string }[];
} | null;

function handle(e: unknown): AutomationState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

export async function createAutomationAction(_prev: AutomationState, form: FormData): Promise<AutomationState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;

    const limit = checkAutomationLimit(orgId);
    if (!limit.allowed) return { error: limit.reason ?? "Automation limit reached." };

    const name = str(form.get("name"), "Automation name", { min: 3, max: 120 });
    const description = optionalStr(form.get("description"), 500) || undefined;
    const triggerType = oneOf(form.get("trigger_type"), "Trigger", TRIGGERS, "lead.created") as TriggerType;
    const runLimit = Math.max(1, Math.min(5000, Number(form.get("run_limit_per_day") ?? 100) || 100));

    type Cond = { field: string; op: "equals" | "not_equals" | "gt" | "lt" | "contains" | "exists"; value?: string };
    const ALLOWED_OPS = new Set(["equals", "not_equals", "gt", "lt", "contains", "exists"]);
    const ALLOWED_TRIGGER_FIELDS = new Set(["status", "source", "value_cents", "company", "email", "name", "notes"]);

    // The builder posts JSON arrays; the older parallel-array form is still accepted.
    const conditions: Cond[] = [];
    const rawConditions = String(form.get("conditions_json") ?? "").trim();
    if (rawConditions) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawConditions);
      } catch {
        throw new ValidationError("Conditions were not valid JSON.");
      }
      if (!Array.isArray(parsed)) throw new ValidationError("Conditions must be a list.");
      for (const item of parsed) {
        const c = item as { field?: unknown; op?: unknown; value?: unknown };
        const field = String(c.field ?? "").trim();
        if (!field) continue;
        if (!ALLOWED_TRIGGER_FIELDS.has(field)) throw new ValidationError(`Condition field "${field}" is not supported.`);
        const op = String(c.op ?? "equals");
        if (!ALLOWED_OPS.has(op)) throw new ValidationError(`Condition operator "${op}" is not supported.`);
        conditions.push({ field, op: op as Cond["op"], value: String(c.value ?? "") });
      }
    } else {
      const fields = form.getAll("condition_field").map((v) => String(v).trim());
      const ops = form.getAll("condition_op").map((v) => String(v));
      const values = form.getAll("condition_value").map((v) => String(v));
      fields.forEach((field, i) => {
        if (!field) return;
        conditions.push({ field, op: ((ops[i] ?? "equals") as Cond["op"]), value: values[i] ?? "" });
      });
    }

    type StepInput = { actionType: ActionType; config: Record<string, unknown>; requiresApproval: boolean };
    const steps: StepInput[] = [];
    const rawSteps = String(form.get("steps_json") ?? "").trim();
    if (rawSteps) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawSteps);
      } catch {
        throw new ValidationError("Steps were not valid JSON.");
      }
      if (!Array.isArray(parsed)) throw new ValidationError("Steps must be a list.");
      for (const [i, item] of parsed.entries()) {
        const s = item as { action?: unknown; config?: unknown };
        const actionType = String(s.action ?? "");
        if (!actionType) continue;
        if (!(ACTIONS as readonly string[]).includes(actionType)) {
          throw new ValidationError(`Step ${i + 1}: "${actionType}" is not a known action.`);
        }
        const config =
          s.config && typeof s.config === "object" ? (s.config as Record<string, unknown>) : {};
        steps.push({
          actionType: actionType as ActionType,
          config,
          // External-facing actions always need human approval.
          requiresApproval: actionType === "send_email",
        });
      }
    } else {
      const actions = form.getAll("step_action").map((v) => String(v));
      const configs = form.getAll("step_config").map((v) => String(v));
      actions.forEach((action, i) => {
        if (!action) return;
        let config: Record<string, unknown> = {};
        const raw = (configs[i] ?? "").trim();
        if (raw) {
          try {
            config = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            throw new ValidationError(`Step ${i + 1}: configuration must be valid JSON.`);
          }
        }
        steps.push({ actionType: action as ActionType, config, requiresApproval: action === "send_email" });
      });
    }

    if (steps.length === 0) throw new ValidationError("Add at least one action step.");
    if (steps.length > 10) throw new ValidationError("An automation can have at most 10 steps.");

    const id = createAutomationWithSteps({
      organizationId: orgId, createdBy: user.id, name, description, triggerType, conditions, steps,
    });
    run("update automations set run_limit_per_day = ? where id = ? and organization_id = ?", [runLimit, id, orgId]);

    logActivity({ organizationId: orgId, actorId: user.id, entityType: "automation", entityId: id, action: "automation.created", summary: `Automation "${name}" created` });
    audit({ organizationId: orgId, actorId: user.id, action: "automation.create", targetType: "automation", targetId: id });
    revalidatePath("/automations");
    return { notice: `Automation "${name}" created with ${steps.length} step${steps.length === 1 ? "" : "s"}. Use “Test run” to check it safely.` };
  } catch (e) {
    return handle(e);
  }
}

export async function toggleAutomationAction(form: FormData): Promise<void> {
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const id = String(form.get("automation_id") ?? "");
  const row = get<{ is_active: number }>("select is_active from automations where id = ? and organization_id = ?", [id, orgId]);
  if (!row) return;
  run("update automations set is_active = ?, updated_at = ? where id = ? and organization_id = ?", [row.is_active ? 0 : 1, nowIso(), id, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: row.is_active ? "automation.deactivate" : "automation.activate", targetType: "automation", targetId: id });
  revalidatePath("/automations");
}

export async function deleteAutomationAction(form: FormData): Promise<void> {
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const id = String(form.get("automation_id") ?? "");
  run("delete from automation_executions where automation_id = ? and organization_id = ?", [id, orgId]);
  run("delete from automation_steps where automation_id = ? and organization_id = ?", [id, orgId]);
  run("delete from automations where id = ? and organization_id = ?", [id, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: "automation.delete", targetType: "automation", targetId: id });
  revalidatePath("/automations");
}

/** Manual test mode: always a dry run, never writes executions or sends anything. */
export async function testAutomationAction(_prev: AutomationState, form: FormData): Promise<AutomationState> {
  try {
    const { membership } = await requireAuth();
    const orgId = membership.organization_id;
    const id = str(form.get("automation_id"), "Automation", { min: 4 });
    const automation = get<{ id: string; name: string; trigger_type: TriggerType }>(
      "select id, name, trigger_type from automations where id = ? and organization_id = ?",
      [id, orgId]
    );
    if (!automation) return { error: "Automation not found in this workspace." };

    const sampleLeadId = optionalStr(form.get("sample_lead_id"), 60) || null;
    const lead = sampleLeadId
      ? get<Record<string, unknown>>("select * from leads where id = ? and organization_id = ?", [sampleLeadId, orgId])
      : null;
    const entity: TriggerEntity = {
      type: "lead",
      id: (lead?.id as string) ?? "sample-lead",
      data: lead ?? { id: "sample-lead", name: "Sample Lead", email: "sample@example.com", status: "new", source: "manual", value_cents: 100000, company: "Sample Co", notes: "Dry run sample" },
    };

    const results = await testAutomation(orgId, automation.id, entity);
    const matched = results.find((r) => r.automationId === automation.id);
    return {
      notice: matched
        ? `Test finished: ${matched.status}. Nothing was sent and no execution row was written.`
        : "No result — check that the automation is active and the trigger matches.",
      log: matched?.log ?? [],
      results: results.map((r) => ({ name: r.automationName, status: r.status, reason: r.reason })),
    };
  } catch (e) {
    return handle(e);
  }
}

/** Explicit retry of a failed run. The old row is removed so the same event can run again. */
export async function retryExecutionAction(_prev: AutomationState, form: FormData): Promise<AutomationState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    const executionId = str(form.get("execution_id"), "Execution", { min: 4 });

    const exec = get<{ id: string; automation_id: string; status: string; trigger_entity_type: string | null; trigger_entity_id: string | null }>(
      "select id, automation_id, status, trigger_entity_type, trigger_entity_id from automation_executions where id = ? and organization_id = ?",
      [executionId, orgId]
    );
    if (!exec) return { error: "Execution not found in this workspace." };
    if (exec.status !== "failed") return { error: "Only failed executions can be retried." };

    const automation = get<{ trigger_type: TriggerType; name: string }>(
      "select trigger_type, name from automations where id = ? and organization_id = ?",
      [exec.automation_id, orgId]
    );
    if (!automation) return { error: "The automation for this run no longer exists." };

    let data: Record<string, unknown> = { id: exec.trigger_entity_id };
    if (exec.trigger_entity_type === "lead" && exec.trigger_entity_id) {
      data = get<Record<string, unknown>>("select * from leads where id = ? and organization_id = ?", [exec.trigger_entity_id, orgId]) ?? data;
    }

    run("delete from automation_executions where id = ? and organization_id = ?", [executionId, orgId]);
    const results = await dispatchTrigger(
      orgId,
      automation.trigger_type,
      { type: (exec.trigger_entity_type as TriggerEntity["type"]) ?? "lead", id: exec.trigger_entity_id ?? "retry", data },
      { actorId: user.id, automationId: exec.automation_id }
    );
    const mine = results.find((r) => r.automationId === exec.automation_id);
    revalidatePath("/automations");
    return {
      notice: mine ? `Retry ${mine.status}.` : "Retry finished with no result.",
      log: mine?.log ?? [],
      error: mine?.status === "failed" ? mine.reason : undefined,
    };
  } catch (e) {
    return handle(e);
  }
}

export async function listAutomationsWithStats(organizationId: string) {
  return all<{
    id: string; name: string; description: string | null; trigger_type: TriggerType; is_active: number;
    run_limit_per_day: number; last_run_at: string | null; created_at: string;
    steps: number; runs: number; failures: number;
  }>(
    `select a.id, a.name, a.description, a.trigger_type, a.is_active, a.run_limit_per_day, a.last_run_at, a.created_at,
            (select count(*) from automation_steps s where s.automation_id = a.id) as steps,
            (select count(*) from automation_executions e where e.automation_id = a.id) as runs,
            (select count(*) from automation_executions e where e.automation_id = a.id and e.status = 'failed') as failures
       from automations a where a.organization_id = ? order by a.created_at desc`,
    [organizationId]
  );
}

