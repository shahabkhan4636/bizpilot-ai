import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { get, resetDatabaseForTests, run } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import {
  ALL_FEATURES,
  checkAiLimit,
  checkAutomationLimit,
  checkDocumentLimit,
  checkFeature,
  checkLeadLimit,
  getEffectivePlan,
  isPlatformOwnerWorkspace,
  leadCount,
  recordUsage,
  subscriptionIsUsable,
} from "@/lib/plans";
import { isUnlimited, limitLabel, usageLabel, UNLIMITED } from "@/lib/limits";
import { grantFoundingMembership } from "@/lib/platform-payments-server";

/**
 * Phase 4 — the platform owner's own workspace has no limits.
 *
 * Two failure modes matter here, and both are security questions rather than UI ones:
 *
 *  1. The owner must not be blocked by the plan engine of the product they sell
 *     (a "you have used all 250 leads" banner in your own demo is absurd).
 *  2. Unlimited limits must **never** leak to a paying customer. Being invited into
 *     someone else's workspace as admin/viewer must not give that workspace a free
 *     ride, so the rule requires the owner to be a member with role `owner` — and an
 *     unset `ADMIN_EMAIL` gives unlimited to nobody.
 */

const ORIGINAL_ENV = { ADMIN_EMAIL: process.env.ADMIN_EMAIL };
const OWNER_EMAIL = "owner@bizpilot.test";

beforeEach(() => {
  resetDatabaseForTests();
  process.env.ADMIN_EMAIL = OWNER_EMAIL;
});

afterEach(() => {
  if (ORIGINAL_ENV.ADMIN_EMAIL === undefined) delete process.env.ADMIN_EMAIL;
  else process.env.ADMIN_EMAIL = ORIGINAL_ENV.ADMIN_EMAIL;
});

function seedWorkspace(options: { email: string; role?: string; planCode?: string; withSubscription?: boolean } = { email: "" }) {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `org-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId,
    options.email,
    null,
    "Seed User",
    now,
    now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [
    orgId,
    `Org ${slug}`,
    slug,
    now,
    now,
  ]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(),
    orgId,
    userId,
    options.role ?? "owner",
    now,
  ]);
  if (options.withSubscription !== false) {
    run(
      "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, created_at, updated_at) values (?,?,?,?,?,?,?)",
      [newId(), orgId, options.planCode ?? "starter", "active", "monthly", now, now]
    );
  }
  return { userId, orgId, slug };
}

/** Adds an existing profile to another workspace in the given role. */
function addMember(orgId: string, email: string, role: string) {
  const now = nowIso();
  const userId = newId();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId,
    email,
    null,
    "Member",
    now,
    now,
  ]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(),
    orgId,
    userId,
    role,
    now,
  ]);
  return userId;
}

function fillToLimit(orgId: string, count: number) {
  const now = nowIso();
  for (let i = 0; i < count; i += 1) {
    run("insert into leads (id, organization_id, name, email, status, created_at, updated_at) values (?,?,?,?,?,?,?)", [
      newId(),
      orgId,
      `Lead ${i}`,
      `lead${i}.${newToken(3)}@example.com`,
      "new",
      now,
      now,
    ]);
  }
}

describe("which workspace counts as the platform owner's", () => {
  it("is the workspace where the ADMIN_EMAIL account is the owner", () => {
    const ownerWs = seedWorkspace({ email: OWNER_EMAIL });
    const customerWs = seedWorkspace({ email: "customer@example.com" });
    expect(isPlatformOwnerWorkspace(ownerWs.orgId)).toBe(true);
    expect(isPlatformOwnerWorkspace(customerWs.orgId)).toBe(false);
  });

  it("is case- and whitespace-insensitive on the configured address", () => {
    process.env.ADMIN_EMAIL = `  ${OWNER_EMAIL.toUpperCase()}  `;
    const ownerWs = seedWorkspace({ email: OWNER_EMAIL });
    expect(isPlatformOwnerWorkspace(ownerWs.orgId)).toBe(true);
  });

  it("does NOT extend to a workspace the owner merely joined as admin or viewer", () => {
    const customerWs = seedWorkspace({ email: "customer@example.com" });
    addMember(customerWs.orgId, OWNER_EMAIL, "admin");
    expect(isPlatformOwnerWorkspace(customerWs.orgId)).toBe(false);
    expect(getEffectivePlan(customerWs.orgId).lead_limit).toBeLessThan(UNLIMITED);
  });

  it("gives unlimited to nobody when ADMIN_EMAIL is unset", () => {
    delete process.env.ADMIN_EMAIL;
    const ws = seedWorkspace({ email: OWNER_EMAIL });
    expect(isPlatformOwnerWorkspace(ws.orgId)).toBe(false);
    const plan = getEffectivePlan(ws.orgId);
    expect(plan.isPlatformOwner).toBe(false);
    expect(isUnlimited(plan.lead_limit)).toBe(false);
  });

  it("follows ADMIN_EMAIL when it changes", () => {
    const ws = seedWorkspace({ email: OWNER_EMAIL });
    expect(isPlatformOwnerWorkspace(ws.orgId)).toBe(true);
    process.env.ADMIN_EMAIL = "someone-else@example.com";
    expect(isPlatformOwnerWorkspace(ws.orgId)).toBe(false);
  });
});

describe("the owner's plan", () => {
  it("has no limits and every feature, while the plan code stays honest", () => {
    const { orgId } = seedWorkspace({ email: OWNER_EMAIL });
    const plan = getEffectivePlan(orgId);
    expect(plan.isPlatformOwner).toBe(true);
    expect(plan.code).toBe("starter"); // still the catalogue row it is on
    expect(plan.lead_limit).toBe(UNLIMITED);
    expect(plan.member_limit).toBe(UNLIMITED);
    expect(plan.ai_generation_limit).toBe(UNLIMITED);
    expect(plan.automation_limit).toBe(UNLIMITED);
    expect(plan.document_limit).toBe(UNLIMITED);
    expect(plan.featuresParsed).toEqual(ALL_FEATURES);
  });

  it("wins over the Founding Member seat count", () => {
    const { orgId } = seedWorkspace({ email: OWNER_EMAIL });
    grantFoundingMembership({ organizationId: orgId, actorId: null, source: "manual" });
    expect(getEffectivePlan(orgId).member_limit).toBe(UNLIMITED);
  });

  it("leaves a paying customer's plan exactly as the catalogue says", () => {
    const { orgId } = seedWorkspace({ email: "customer@example.com" });
    const catalogue = get<{ lead_limit: number; member_limit: number; ai_generation_limit: number }>(
      "select lead_limit, member_limit, ai_generation_limit from plans where code = 'starter'"
    )!;
    const plan = getEffectivePlan(orgId);
    expect(plan.isPlatformOwner).toBe(false);
    expect(plan.lead_limit).toBe(catalogue.lead_limit);
    expect(plan.member_limit).toBe(catalogue.member_limit);
    expect(plan.ai_generation_limit).toBe(catalogue.ai_generation_limit);
  });
});

describe("enforcement at the action layer", () => {
  it("never blocks the owner on leads, AI, documents or automations", () => {
    const ownerWs = seedWorkspace({ email: OWNER_EMAIL });
    const catalogue = get<{ lead_limit: number; ai_generation_limit: number; document_limit: number; automation_limit: number }>(
      "select lead_limit, ai_generation_limit, document_limit, automation_limit from plans where code = 'starter'"
    )!;

    // Push the owner's workspace past every catalogue limit.
    fillToLimit(ownerWs.orgId, catalogue.lead_limit + 10);
    for (let i = 0; i < catalogue.ai_generation_limit + 5; i += 1) {
      recordUsage(ownerWs.orgId, "ai_generation", 1);
    }
    const now = nowIso();
    for (let i = 0; i < catalogue.document_limit + 3; i += 1) {
      run(
        "insert into documents (id, organization_id, file_name, mime_type, size_bytes, storage_path, uploaded_by, created_at) values (?,?,?,?,?,?,?,?)",
        [newId(), ownerWs.orgId, `doc-${i}.txt`, "text/plain", 10, `/tmp/doc-${i}.txt`, null, now]
      );
    }
    for (let i = 0; i < catalogue.automation_limit + 2; i += 1) {
      run(
        "insert into automations (id, organization_id, name, trigger_type, is_active, created_at, updated_at) values (?,?,?,?,?,?,?)",
        [newId(), ownerWs.orgId, `Automation ${i}`, "manual", 1, now, now]
      );
    }

    expect(leadCount(ownerWs.orgId)).toBeGreaterThan(catalogue.lead_limit);
    expect(checkLeadLimit(ownerWs.orgId).allowed).toBe(true);
    expect(checkAiLimit(ownerWs.orgId).allowed).toBe(true);
    expect(checkDocumentLimit(ownerWs.orgId).allowed).toBe(true);
    expect(checkAutomationLimit(ownerWs.orgId).allowed).toBe(true);
  });

  it("still blocks a customer at the same numbers", () => {
    const customerWs = seedWorkspace({ email: "customer@example.com" });
    const catalogue = get<{ lead_limit: number; ai_generation_limit: number }>(
      "select lead_limit, ai_generation_limit from plans where code = 'starter'"
    )!;
    fillToLimit(customerWs.orgId, catalogue.lead_limit);
    for (let i = 0; i < catalogue.ai_generation_limit; i += 1) recordUsage(customerWs.orgId, "ai_generation", 1);

    const leads = checkLeadLimit(customerWs.orgId);
    expect(leads.allowed).toBe(false);
    expect(leads.reason).toMatch(/upgrade/i);
    expect(checkAiLimit(customerWs.orgId).allowed).toBe(false);
  });

  it("unlocks features the plan does not include — for the owner only", () => {
    const ownerWs = seedWorkspace({ email: OWNER_EMAIL });
    const customerWs = seedWorkspace({ email: "customer@example.com" });

    // Starter excludes automations; the invariant must hold for the customer.
    expect(checkFeature(customerWs.orgId, "automations").allowed).toBe(false);
    expect(checkFeature(ownerWs.orgId, "automations").allowed).toBe(true);
    expect(checkFeature(ownerWs.orgId, "white_label").allowed).toBe(true);
  });

  it("treats the owner's workspace as subscribed even with no subscription row", () => {
    const ownerWs = seedWorkspace({ email: OWNER_EMAIL, withSubscription: false });
    const customerWs = seedWorkspace({ email: "customer@example.com", withSubscription: false });
    expect(subscriptionIsUsable(ownerWs.orgId)).toBe(true);
    expect(subscriptionIsUsable(customerWs.orgId)).toBe(false);
  });

  it("keeps a trialing customer's expiry working (owner rule does not hide it)", () => {
    const customerWs = seedWorkspace({ email: "customer@example.com" });
    run("update subscriptions set status = 'trialing', trial_ends_at = ? where organization_id = ?", [
      new Date(Date.now() - 86_400_000).toISOString(),
      customerWs.orgId,
    ]);
    expect(subscriptionIsUsable(customerWs.orgId)).toBe(false);
  });
});

describe("limit labels", () => {
  it("prints Unlimited instead of infinity", () => {
    expect(limitLabel(UNLIMITED)).toBe("Unlimited");
    expect(limitLabel(250)).toBe("250");
    expect(limitLabel(1500)).toBe("1,500");
    expect(isUnlimited(UNLIMITED)).toBe(true);
    expect(isUnlimited(250)).toBe(false);
    expect(isUnlimited(null)).toBe(false);
    expect(usageLabel(12, UNLIMITED)).toBe("12 / Unlimited");
    expect(usageLabel(12, 250)).toBe("12 / 250");
  });
});
