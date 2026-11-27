import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { all, get, resetDatabaseForTests, run } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import {
  BILLING_CYCLES,
  LOCAL_METHOD_KINDS,
  LOCAL_METHOD_LABEL,
  isFullyRefunded,
  maskAccountNumber,
  paymentReference,
  pkrPerUsd,
  periodEndFrom,
  toPkrRupees,
  validateLocalMethod,
  validatePaymentLink,
  validateRefund,
} from "@/lib/local-payments";
import { approveLocalPaymentRequest, ensureSubscriptionPlan, findOrganizationByReference } from "@/lib/payments/approve";

/**
 * Regression lock for `/billing/local`.
 *
 * Phase 3 added a *second* money flow (customers paying BizPilot) and moved the
 * subscription write into `ensureSubscriptionPlan`, which the new flow shares. These
 * tests exist so that refactor can never quietly change what the workspace flow
 * already did: same amount maths, same reference format, same approval semantics,
 * same refund rules.
 */

const ORIGINAL_ENV = { PKR_PER_USD: process.env.PKR_PER_USD };

beforeEach(() => {
  resetDatabaseForTests();
  delete process.env.PKR_PER_USD;
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function seedWorkspace(planCode = "starter") {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `local-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId,
    `${slug}@example.com`,
    null,
    "Local Owner",
    now,
    now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, `Org ${slug}`, slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [newId(), orgId, userId, "owner", now]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, created_at, updated_at) values (?,?,?,?,?,?,?)",
    [newId(), orgId, planCode, "active", "monthly", now, now]
  );
  return { userId, orgId, slug };
}

function insertRequest(orgId: string, userId: string, over: Partial<{ planCode: string; cycle: string; amountCents: number; status: string }> = {}) {
  const id = newId();
  const now = nowIso();
  run(
    `insert into local_payment_requests
       (id, organization_id, plan_code, billing_cycle, amount_cents, currency, reference, status, submitted_by, submitted_at)
     values (?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      orgId,
      over.planCode ?? "professional",
      over.cycle ?? "monthly",
      over.amountCents ?? 500000,
      "PKR",
      `REF-${newToken(4)}`,
      over.status ?? "pending",
      userId,
      now,
    ]
  );
  return id;
}

describe("/billing/local — amount and method rules", () => {
  it("keeps the method catalogue stable", () => {
    expect([...LOCAL_METHOD_KINDS]).toEqual(["sadapay", "jazzcash", "easypaisa", "bank", "other"]);
    expect(LOCAL_METHOD_LABEL.sadapay).toBe("SadaPay");
    expect(LOCAL_METHOD_LABEL.bank).toMatch(/IBAN/i);
  });

  it("keeps the PKR/USD rate configurable with a 280 default", () => {
    expect(pkrPerUsd()).toBe(280);
    process.env.PKR_PER_USD = "285";
    expect(pkrPerUsd()).toBe(285);
    process.env.PKR_PER_USD = "not-a-number";
    expect(pkrPerUsd()).toBe(280);
  });

  it("rounds the suggested amount up to the next Rs 100", () => {
    expect(toPkrRupees(2900, 280)).toBe(8200); // Rs 29 → 8,120 → 8,200
    expect(toPkrRupees(0, 280)).toBe(0);
    expect(toPkrRupees(-5, 280)).toBe(0);
  });

  it("accepts valid wallet numbers and rejects junk", () => {
    const base = { kind: "sadapay" as const, accountTitle: "Local Owner", paymentLink: null };
    expect(validateLocalMethod({ ...base, accountNumber: "03001234567" })).toBeNull();
    expect(validateLocalMethod({ ...base, accountNumber: "12" })).toBeTruthy();
    expect(validateLocalMethod({ ...base, accountTitle: "", accountNumber: "03001234567" })).toBeTruthy();
  });

  it("masks account numbers for display", () => {
    expect(maskAccountNumber("03001234567")).toContain("4567");
    expect(maskAccountNumber("03001234567")).not.toContain("03001");
  });

  it("keeps payment links optional but validated when present", () => {
    expect(validatePaymentLink(null)).toBeNull();
    expect(validatePaymentLink("")).toBeNull();
    expect(validatePaymentLink("not a url")).toBeTruthy();
    expect(validatePaymentLink("https://sadapay.pk/pay/abc")).toBeNull();
  });
});

describe("/billing/local — references and periods", () => {
  it("keeps the transfer-note format stable", () => {
    const reference = paymentReference("Acme-Studio");
    expect(reference.startsWith("BP-")).toBe(true);
    expect(reference).toMatch(/^BP-ACMESTUD-[A-Z0-9]+$/);
    // The prefix is normalised, the digest is not: the workspace slug must be typed
    // exactly as it appears, which is what `findOrganizationByReference` compares.
    expect(reference).toBe(paymentReference("Acme-Studio"));
    expect(paymentReference("acme-studio")).not.toBe(reference);
    expect(reference).not.toBe(paymentReference("other-workspace"));
  });

  it("resolves a reference back to exactly one workspace", () => {
    const { slug, orgId } = seedWorkspace();
    const found = findOrganizationByReference(paymentReference(slug));
    expect(found?.id).toBe(orgId);
    expect(findOrganizationByReference("BP-NOPE")).toBeNull();
  });

  it("computes monthly and annual periods the same way as before", () => {
    const from = new Date("2026-01-15T10:00:00.000Z");
    const monthly = new Date(periodEndFrom("monthly", from));
    expect(monthly.getUTCMonth()).toBe(1); // February
    expect(monthly.getUTCDate()).toBe(15);
    const annual = new Date(periodEndFrom("annual", from));
    expect(annual.getUTCFullYear()).toBe(2027);
    expect([...BILLING_CYCLES]).toEqual(["monthly", "annual"]);
  });
});

describe("/billing/local — approval semantics (unchanged)", () => {
  it("approves once, activates the plan and audits with the actor", () => {
    const { orgId, userId } = seedWorkspace("starter");
    const requestId = insertRequest(orgId, userId);
    const outcome = approveLocalPaymentRequest({ organizationId: orgId, requestId, actorId: userId, note: "seen in SadaPay" });
    expect(outcome.ok).toBe(true);

    const sub = get<{ plan_code: string; status: string; billing_cycle: string }>(
      "select plan_code, status, billing_cycle from subscriptions where organization_id = ?",
      [orgId]
    );
    expect(sub).toMatchObject({ plan_code: "professional", status: "active", billing_cycle: "monthly" });

    const auditRow = get<{ actor_id: string; metadata: string }>(
      "select actor_id, metadata from audit_logs where action = 'local_payment.approved' order by created_at desc limit 1"
    );
    expect(auditRow?.actor_id).toBe(userId);
    expect(auditRow?.metadata).toContain("manual approval");
  });

  it("refuses a second approval of the same request", () => {
    const { orgId, userId } = seedWorkspace();
    const requestId = insertRequest(orgId, userId);
    expect(approveLocalPaymentRequest({ organizationId: orgId, requestId, actorId: userId }).ok).toBe(true);
    const again = approveLocalPaymentRequest({ organizationId: orgId, requestId, actorId: userId });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.message).toMatch(/already approved/i);
    expect(all("select id from audit_logs where action = 'local_payment.approved'").length).toBe(1);
  });

  it("refuses a request that belongs to another workspace", () => {
    const a = seedWorkspace();
    const b = seedWorkspace();
    const requestId = insertRequest(a.orgId, a.userId);
    const outcome = approveLocalPaymentRequest({ organizationId: b.orgId, requestId, actorId: b.userId });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/does not belong/i);
  });

  it("records a gateway approval with a null actor", () => {
    const { orgId, userId } = seedWorkspace();
    const requestId = insertRequest(orgId, userId);
    const outcome = approveLocalPaymentRequest({
      organizationId: orgId,
      requestId,
      actorId: null,
      gateway: { provider: "safepay", paymentId: "sp_123" },
    });
    expect(outcome.ok).toBe(true);
    const row = get<{ gateway_provider: string; gateway_payment_id: string; paid_at: string }>(
      "select gateway_provider, gateway_payment_id, paid_at from local_payment_requests where id = ?",
      [requestId]
    );
    expect(row).toMatchObject({ gateway_provider: "safepay", gateway_payment_id: "sp_123" });
    expect(row?.paid_at).toBeTruthy();
    const auditRow = get<{ actor_id: string | null; metadata: string }>(
      "select actor_id, metadata from audit_logs where action = 'local_payment.approved' order by created_at desc limit 1"
    );
    expect(auditRow?.actor_id).toBeNull();
    expect(auditRow?.metadata).toContain("safepay:sp_123");
  });

  it("never approves a cancelled or rejected request", () => {
    const { orgId, userId } = seedWorkspace();
    for (const status of ["cancelled", "rejected", "approved"]) {
      const requestId = insertRequest(orgId, userId, { status });
      const outcome = approveLocalPaymentRequest({ organizationId: orgId, requestId, actorId: userId });
      expect(outcome.ok).toBe(false);
    }
  });

  it("ensureSubscriptionPlan creates a row for a workspace that has none", () => {
    const { orgId } = seedWorkspace();
    run("delete from subscriptions where organization_id = ?", [orgId]);
    const periodEnd = ensureSubscriptionPlan({ organizationId: orgId, planCode: "business", billingCycle: "annual" });
    const sub = get<{ plan_code: string; status: string; current_period_end: string }>(
      "select plan_code, status, current_period_end from subscriptions where organization_id = ?",
      [orgId]
    );
    expect(sub).toMatchObject({ plan_code: "business", status: "active", current_period_end: periodEnd });
    expect(new Date(periodEnd).getUTCFullYear()).toBeGreaterThan(new Date().getUTCFullYear() - 1);
  });

  it("clears a trial and any pending cancellation when a plan is activated", () => {
    const { orgId, userId } = seedWorkspace();
    run("update subscriptions set status = 'trialing', trial_ends_at = ?, cancel_at_period_end = 1 where organization_id = ?", [
      addDays(5).toISOString(),
      orgId,
    ]);
    const requestId = insertRequest(orgId, userId);
    expect(approveLocalPaymentRequest({ organizationId: orgId, requestId, actorId: userId }).ok).toBe(true);
    const sub = get<{ status: string; trial_ends_at: string | null; cancel_at_period_end: number }>(
      "select status, trial_ends_at, cancel_at_period_end from subscriptions where organization_id = ?",
      [orgId]
    );
    expect(sub).toMatchObject({ status: "active", trial_ends_at: null, cancel_at_period_end: 0 });
  });
});

describe("/billing/local — refund rules (unchanged)", () => {
  it("never refunds more than was paid", () => {
    expect(validateRefund({ paidCents: 500000, alreadyRefundedCents: 0, amountCents: 500000 })).toBeNull();
    expect(validateRefund({ paidCents: 500000, alreadyRefundedCents: 0, amountCents: 500001 })).toBeTruthy();
    expect(validateRefund({ paidCents: 500000, alreadyRefundedCents: 400000, amountCents: 200000 })).toBeTruthy();
    expect(validateRefund({ paidCents: 500000, alreadyRefundedCents: 0, amountCents: 0 })).toBeTruthy();
  });

  it("detects a fully refunded payment", () => {
    expect(isFullyRefunded(500000, 500000)).toBe(true);
    expect(isFullyRefunded(500000, 499999)).toBe(false);
  });
});
