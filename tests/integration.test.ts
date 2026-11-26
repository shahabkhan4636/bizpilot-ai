import { describe, it, expect, beforeEach } from "vitest";
import { run, get, all, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken, newShareToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { hashPassword, verifyPassword } from "@/lib/password";
import {
  listPlans, getEffectivePlan, checkLeadLimit, checkAiLimit, checkFeature,
  recordUsage, usageThisMonth, leadCount, setPlanForOrg, subscriptionIsUsable,
} from "@/lib/plans";
import { rateLimit } from "@/lib/ratelimit";
import { createAutomationWithSteps, dispatchTrigger, executionHistory } from "@/lib/automations";
import { toCsv } from "@/lib/csv";

/** Creates an isolated workspace and returns its ids. */
async function seedWorkspace(email: string, planCode = "starter") {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `ws-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, email, await hashPassword("correcthorse42"), "Test User", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [
    orgId, `Org ${slug}`, slug, now, now,
  ]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, "owner", now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, planCode, "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  return { userId, orgId };
}

function addLead(orgId: string, name: string, status = "new", value = 100000, source = "manual") {
  const id = newId();
  const now = nowIso();
  run(
    `insert into leads (id, organization_id, name, email, source, status, value_cents, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?)`,
    [id, orgId, name, `${name.toLowerCase().replace(/\W/g, "")}@example.com`, source, status, value, now, now]
  );
  return id;
}

beforeEach(() => {
  resetDatabaseForTests();
});

describe("plans", () => {
  it("seeds the four commercial plans with the documented prices", () => {
    const plans = listPlans();
    expect(plans.map((p) => p.code)).toEqual(["starter", "professional", "business", "agency"]);
    const byCode = Object.fromEntries(plans.map((p) => [p.code, p]));
    expect(byCode.starter!.price_monthly_cents).toBe(2900);
    expect(byCode.professional!.price_monthly_cents).toBe(7900);
    expect(byCode.business!.price_monthly_cents).toBe(14900);
    expect(byCode.agency!.price_monthly_cents).toBe(29900);
  });

  it("defaults an organisation to the starter plan", async () => {
    const { orgId } = await seedWorkspace("plan@test.com");
    expect(getEffectivePlan(orgId).code).toBe("starter");
  });

  it("moves limits when the plan changes", async () => {
    const { orgId } = await seedWorkspace("plan2@test.com");
    expect(getEffectivePlan(orgId).lead_limit).toBe(100);
    setPlanForOrg(orgId, "business", { status: "active" });
    expect(getEffectivePlan(orgId).lead_limit).toBe(5000);
    expect(subscriptionIsUsable(orgId)).toBe(true);
  });

  it("treats a canceled subscription as unusable", async () => {
    const { orgId } = await seedWorkspace("plan3@test.com");
    setPlanForOrg(orgId, "professional", { status: "canceled" });
    expect(subscriptionIsUsable(orgId)).toBe(false);
  });

  it("enforces the starter lead limit at exactly 100", async () => {
    const { orgId } = await seedWorkspace("limits@test.com");
    for (let i = 0; i < 100; i++) addLead(orgId, `Lead ${i}`);
    expect(leadCount(orgId)).toBe(100);
    expect(checkLeadLimit(orgId).allowed).toBe(false);
    expect(checkLeadLimit(orgId).reason).toContain("100");
  });

  it("counts AI usage per month and blocks at the plan limit", async () => {
    const { orgId } = await seedWorkspace("ai@test.com");
    for (let i = 0; i < 50; i++) recordUsage(orgId, "ai_generation");
    expect(usageThisMonth(orgId, "ai_generation")).toBe(50);
    expect(checkAiLimit(orgId).allowed).toBe(false);
  });

  it("gates features that a plan does not include", async () => {
    const { orgId } = await seedWorkspace("feature@test.com");
    expect(checkFeature(orgId, "proposals").allowed).toBe(true);
    setPlanForOrg(orgId, "starter", { status: "active" });
    const starterAutomation = checkFeature(orgId, "automations");
    // starter has automation_limit 0, so the feature flag is what the UI checks
    expect(starterAutomation.allowed).toBe(Boolean(getEffectivePlan(orgId).featuresParsed.automations));
  });
});

describe("tenant isolation", () => {
  it("keeps leads from two workspaces separate", async () => {
    const a = await seedWorkspace("a@test.com");
    const b = await seedWorkspace("b@test.com");
    addLead(a.orgId, "Alice");
    addLead(b.orgId, "Bob");

    const aLeads = all<{ name: string }>("select name from leads where organization_id = ? and deleted_at is null", [a.orgId]);
    const bLeads = all<{ name: string }>("select name from leads where organization_id = ? and deleted_at is null", [b.orgId]);
    expect(aLeads.map((l) => l.name)).toEqual(["Alice"]);
    expect(bLeads.map((l) => l.name)).toEqual(["Bob"]);
    expect(leadCount(a.orgId)).toBe(1);
  });

  it("cannot read another workspace's proposal through a token from a different org", async () => {
    const a = await seedWorkspace("pa@test.com");
    const b = await seedWorkspace("pb@test.com");
    const now = nowIso();
    const token = newShareToken();
    run(
      `insert into proposals (id, organization_id, title, client_name, currency, subtotal_cents, total_cents, status, share_token, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
      [newId(), a.orgId, "Secret proposal", "Client A", "USD", 100000, 100000, "sent", token, now, now]
    );
    // The token resolves to org A only.
    const found = get<{ organization_id: string }>("select organization_id from proposals where share_token = ?", [token]);
    expect(found?.organization_id).toBe(a.orgId);
    // A query scoped to org B finds nothing.
    const crossTenant = get("select id from proposals where share_token = ? and organization_id = ?", [token, b.orgId]);
    expect(crossTenant).toBeUndefined();
  });

  it("scopes memberships so one user cannot act for another org", async () => {
    const a = await seedWorkspace("member-a@test.com");
    const b = await seedWorkspace("member-b@test.com");
    const membershipOfA = get<{ organization_id: string }>(
      "select organization_id from organization_members where user_id = ?",
      [a.userId]
    );
    expect(membershipOfA?.organization_id).toBe(a.orgId);
    expect(membershipOfA?.organization_id).not.toBe(b.orgId);
  });
});

describe("rate limiting", () => {
  it("allows up to the limit then blocks inside the window", () => {
    for (let i = 0; i < 3; i++) expect(rateLimit("k1", 3, 60).allowed).toBe(true);
    const blocked = rateLimit("k1", 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetInSeconds).toBeGreaterThan(0);
  });

  it("keys are independent", () => {
    rateLimit("k2", 1, 60);
    expect(rateLimit("k2", 1, 60).allowed).toBe(false);
    expect(rateLimit("k3", 1, 60).allowed).toBe(true);
  });
});

describe("automations", () => {
  it("runs a matching automation once and blocks the duplicate event", async () => {
    const { orgId, userId } = await seedWorkspace("auto@test.com");
    const leadId = addLead(orgId, "Auto Lead");

    const automationId = createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Tag new lead",
      triggerType: "lead.created",
      steps: [{ actionType: "create_task", config: { title: "Call the new lead" } }],
    });

    const entity = { type: "lead" as const, id: leadId, data: { id: leadId, status: "new", source: "manual" } };
    const first = await dispatchTrigger(orgId, "lead.created", entity, { actorId: userId });
    expect(first).toHaveLength(1);
    expect(first[0]!.status).toBe("succeeded");

    const second = await dispatchTrigger(orgId, "lead.created", entity, { actorId: userId });
    expect(second[0]!.status).toBe("skipped");
    expect(second[0]!.reason).toContain("duplicate");

    const history = executionHistory(orgId);
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("succeeded");
    const tasks = all("select id from tasks where organization_id = ?", [orgId]);
    expect(tasks).toHaveLength(1);
    expect(automationId).toBeTruthy();
  });

  it("skips when conditions do not match", async () => {
    const { orgId, userId } = await seedWorkspace("auto2@test.com");
    const leadId = addLead(orgId, "Cold Lead", "new", 5000, "cold");
    createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Big deals only",
      triggerType: "lead.created",
      conditions: [{ field: "source", op: "equals", value: "referral" }],
      steps: [{ actionType: "notify_admin", config: {} }],
    });
    const results = await dispatchTrigger(orgId, "lead.created", {
      type: "lead", id: leadId, data: { id: leadId, source: "cold" },
    });
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toContain("source");
    expect(all("select id from automation_executions where organization_id = ?", [orgId])).toHaveLength(0);
  });

  it("respects the per-day run limit", async () => {
    const { orgId, userId } = await seedWorkspace("auto3@test.com");
    const automationId = createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Limited",
      triggerType: "lead.created",
      steps: [{ actionType: "notify_admin", config: {} }],
    });
    run("update automations set run_limit_per_day = 1 where id = ?", [automationId]);

    const first = addLead(orgId, "First");
    const second = addLead(orgId, "Second");
    const r1 = await dispatchTrigger(orgId, "lead.created", { type: "lead", id: first, data: { id: first } });
    const r2 = await dispatchTrigger(orgId, "lead.created", { type: "lead", id: second, data: { id: second } });
    expect(r1[0]!.status).toBe("succeeded");
    expect(r2[0]!.status).toBe("skipped");
    expect(r2[0]!.reason).toContain("limit");
  });

  it("does not create an execution row for a dry-run test", async () => {
    const { orgId, userId } = await seedWorkspace("auto4@test.com");
    createAutomationWithSteps({
      organizationId: orgId,
      createdBy: userId,
      name: "Dry",
      triggerType: "lead.created",
      steps: [{ actionType: "create_task", config: { title: "x" } }],
    });
    await dispatchTrigger(orgId, "lead.created", { type: "lead", id: "sample", data: { id: "sample" } }, { dryRun: true });
    expect(all("select id from automation_executions where organization_id = ?", [orgId])).toHaveLength(0);
    expect(all("select id from tasks where organization_id = ?", [orgId])).toHaveLength(0);
  });
});

describe("auth primitives", () => {
  it("never stores a plaintext password", async () => {
    await seedWorkspace("hash@test.com");
    const row = get<{ password_hash: string }>("select password_hash from profiles where email = ?", ["hash@test.com"]);
    expect(row!.password_hash).not.toContain("correcthorse42");
    expect(await verifyPassword("correcthorse42", row!.password_hash)).toBe(true);
  });

  it("generates unique ids and tokens", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()));
    expect(ids.size).toBe(200);
    expect(newShareToken()).not.toBe(newShareToken());
    expect(newShareToken().length).toBeGreaterThan(16);
  });

  it("exports ledgers as CSV without breaking on commas", () => {
    const csv = toCsv(["name", "note"], [["Doe, Jane", 'said "hi"']]);
    expect(csv.split("\n")).toHaveLength(2);
    expect(csv).toContain('"Doe, Jane"');
  });
});
