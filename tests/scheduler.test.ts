import { describe, it, expect, beforeEach } from "vitest";
import { run, get, all, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { createAutomationWithSteps } from "@/lib/automations";
import { runScheduler, runDueScheduledAutomations, runOverdueFollowups } from "@/lib/scheduler";

/** Workspace with a plan, no leads. */
function seedOrg(planCode = "professional"): { orgId: string; userId: string } {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `sch-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${slug}@example.com`, "x", "Scheduler Test", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, "Sched Org", slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, "owner", now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, planCode, "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  return { orgId, userId };
}

function addLead(orgId: string, followUpAt: string | null, status = "new"): string {
  const id = newId();
  const now = nowIso();
  run(
    `insert into leads (id, organization_id, name, email, source, status, value_cents, next_follow_up_at, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?)`,
    [id, orgId, `Lead ${id.slice(0, 4)}`, `l${id.slice(0, 6)}@example.com`, "manual", status, 100000, followUpAt, now, now]
  );
  return id;
}

function executions(automationId: string) {
  return all<{ id: string; status: string; idempotency_key: string; trigger_entity_id: string }>(
    "select id, status, idempotency_key, trigger_entity_id from automation_executions where automation_id = ?",
    [automationId]
  );
}

describe("scheduled automations", () => {
  beforeEach(() => resetDatabaseForTests());

  it("fires a due schedule once, then waits for its next window", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Every hour task",
      triggerType: "schedule.tick",
      steps: [{ actionType: "create_task", config: { title: "Hourly check" } }],
      scheduleIntervalMinutes: 60,
      nextRunAt: nowIso(),
    });

    const first = await runDueScheduledAutomations(new Date());
    expect(first.filter((r) => r.automationId === automationId && r.status === "succeeded")).toHaveLength(1);
    expect(executions(automationId)).toHaveLength(1);

    // The row is now scheduled in the future, so an immediate second tick does nothing.
    const row = get<{ next_run_at: string }>("select next_run_at from automations where id = ?", [automationId]);
    expect(new Date(row!.next_run_at).getTime()).toBeGreaterThan(Date.now());

    const second = await runDueScheduledAutomations(new Date());
    expect(second.filter((r) => r.automationId === automationId)).toHaveLength(0);
    expect(executions(automationId)).toHaveLength(1);
  });

  it("fires again once the next window arrives", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Every 5 minutes",
      triggerType: "schedule.tick",
      steps: [{ actionType: "create_task", config: { title: "tick" } }],
      scheduleIntervalMinutes: 5,
      nextRunAt: nowIso(),
    });

    await runDueScheduledAutomations(new Date());
    const later = new Date(Date.now() + 6 * 60_000);
    await runDueScheduledAutomations(later);
    expect(executions(automationId)).toHaveLength(2);
  });

  it("a paused automation does not fire", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Paused",
      triggerType: "schedule.tick",
      steps: [{ actionType: "create_task", config: { title: "t" } }],
      scheduleIntervalMinutes: 60,
      nextRunAt: nowIso(),
    });
    run("update automations set is_active = 0 where id = ?", [automationId]);

    await runDueScheduledAutomations(new Date());
    expect(executions(automationId)).toHaveLength(0);
  });

  it("dry run reports the work without writing anything", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Dry",
      triggerType: "schedule.tick",
      steps: [{ actionType: "create_task", config: { title: "t" } }],
      scheduleIntervalMinutes: 60,
      nextRunAt: nowIso(),
    });

    const summary = await runScheduler({ dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.scheduled.some((r) => r.automationId === automationId)).toBe(true);
    expect(executions(automationId)).toHaveLength(0);
    // next_run_at untouched, so the real run still happens later
    const row = get<{ next_run_at: string }>("select next_run_at from automations where id = ?", [automationId]);
    expect(row!.next_run_at).toBeTruthy();
  });

  it("respects the per-day run limit instead of looping", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Limited",
      triggerType: "schedule.tick",
      steps: [{ actionType: "create_task", config: { title: "t" } }],
      scheduleIntervalMinutes: 5,
      nextRunAt: nowIso(),
    });
    run("update automations set run_limit_per_day = 1 where id = ?", [automationId]);

    await runDueScheduledAutomations(new Date());
    await runDueScheduledAutomations(new Date(Date.now() + 6 * 60_000));
    // Second window is skipped by the daily limit.
    const statuses = executions(automationId).map((e) => e.status);
    expect(statuses).toHaveLength(1);
  });
});

describe("overdue follow-up trigger", () => {
  beforeEach(() => resetDatabaseForTests());

  function followupAutomation(orgId: string, userId: string) {
    return createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Overdue nudge",
      triggerType: "followup.overdue",
      steps: [{ actionType: "create_task", config: { title: "Chase the lead" } }],
    });
  }

  it("fires once per lead per due date, not on every tick", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = followupAutomation(orgId, userId);
    const leadId = addLead(orgId, new Date(Date.now() - 3600_000).toISOString());

    const first = await runOverdueFollowups(new Date());
    expect(first).toHaveLength(1);
    const afterFirst = executions(automationId);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].idempotency_key).toContain(leadId);

    const second = await runOverdueFollowups(new Date());
    expect(executions(automationId)).toHaveLength(1);
    expect(second.every((r) => r.status === "skipped")).toBe(true);
  });

  it("ignores leads that are not overdue yet or already closed", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = followupAutomation(orgId, userId);
    addLead(orgId, new Date(Date.now() + 3600_000).toISOString()); // future
    addLead(orgId, new Date(Date.now() - 3600_000).toISOString(), "won");
    addLead(orgId, new Date(Date.now() - 3600_000).toISOString(), "lost");
    const noDate = addLead(orgId, null);

    await runOverdueFollowups(new Date());
    expect(executions(automationId)).toHaveLength(0);
    expect(noDate).toBeTruthy();
  });

  it("a lead that stays overdue fires again only when the due date changes", async () => {
    const { orgId, userId } = seedOrg();
    const automationId = followupAutomation(orgId, userId);
    const leadId = addLead(orgId, new Date(Date.now() - 3600_000).toISOString());

    await runOverdueFollowups(new Date());
    expect(executions(automationId)).toHaveLength(1);

    // The follow-up date is pushed to a new day: a new due date, so it may fire again.
    run("update leads set next_follow_up_at = ? where id = ?", [new Date(Date.now() - 86_400_000).toISOString(), leadId]);
    await runOverdueFollowups(new Date());
    expect(executions(automationId)).toHaveLength(2);
  });

  it("one workspace's scheduler run never touches another workspace's leads", async () => {
    const a = seedOrg();
    const b = seedOrg();
    const automationA = followupAutomation(a.orgId, a.userId);
    const automationB = followupAutomation(b.orgId, b.userId);
    addLead(a.orgId, new Date(Date.now() - 3600_000).toISOString());

    await runOverdueFollowups(new Date());
    expect(executions(automationA)).toHaveLength(1);
    expect(executions(automationB)).toHaveLength(0);
  });
});
