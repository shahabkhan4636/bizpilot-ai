import { describe, it, expect, beforeEach, vi } from "vitest";
import { run, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { createAutomationWithSteps } from "@/lib/automations";

/**
 * The cron endpoint is the only unauthenticated-by-session route that can act on
 * behalf of every workspace, so its guards are tested directly: no secret means it
 * refuses to run at all, a wrong token is a 401, and a correct one does the work.
 */

async function callCron(url = "http://localhost/api/cron/automations", headers: Record<string, string> = {}) {
  const { GET } = await import("@/app/api/cron/automations/route");
  const response = await GET(new Request(url, { headers }));
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

function seedSchedule() {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `cron-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${slug}@example.com`, "x", "Cron Test", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, "Cron Org", slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, "owner", now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, "professional", "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  return createAutomationWithSteps({
    organizationId: orgId,
    createdBy: userId,
    name: "Cron task",
    triggerType: "schedule.tick",
    steps: [{ actionType: "create_task", config: { title: "from cron" } }],
    scheduleIntervalMinutes: 10,
    nextRunAt: nowIso(),
  });
}

describe("cron endpoint", () => {
  beforeEach(() => {
    resetDatabaseForTests();
    vi.unstubAllEnvs();
  });

  it("refuses to run at all when CRON_SECRET is not set", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const automationId = seedSchedule();
    const { status, body } = await callCron();
    expect(status).toBe(503);
    expect(String(body.error)).toMatch(/not configured/i);
    // Nothing ran.
    const runs = run("select 1") && 0;
    expect(runs).toBe(0);
    expect(automationId).toBeTruthy();
  });

  it("rejects a wrong or missing bearer token with 401", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const noHeader = await callCron();
    expect(noHeader.status).toBe(401);
    const wrong = await callCron(undefined, { authorization: "Bearer nope" });
    expect(wrong.status).toBe(401);
  });

  it("runs the scheduler with the right token and reports what it did", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const { status, body } = await callCron(undefined, { authorization: "Bearer s3cret" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.scheduled)).toBe(true);
    expect(Array.isArray(body.overdueFollowups)).toBe(true);
    expect(typeof body.ranAt).toBe("string");
  });

  it("supports a dry run that changes nothing", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const { status, body } = await callCron("http://localhost/api/cron/automations?dryRun=1", {
      authorization: "Bearer s3cret",
    });
    expect(status).toBe(200);
    expect(body.dryRun).toBe(true);
    const executions = run("select 1");
    expect(executions.changes).toBe(0);
  });

  it("accepts a scheduler that sends the secret in x-cron-secret instead", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const { status } = await callCron(undefined, { "x-cron-secret": "s3cret" });
    expect(status).toBe(200);
  });
});
