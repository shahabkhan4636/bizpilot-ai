import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { all, get, resetDatabaseForTests, run } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import {
  FOUNDING_MEMBER_DEFAULTS,
  foundingSlotsLeft,
  isFoundingEligible,
  isPlatformConfigured,
  platformMethods,
  resolveClaimAmountCents,
  validatePlatformSettings,
  type PlatformSettings,
} from "@/lib/platform-payments";
import {
  foundingForOrg,
  foundingGrantedCount,
  getPlatformSettings,
  grantFoundingMembership,
  listAllClaims,
  openClaimForOrg,
  quoteForClaim,
  reviewPlatformClaim,
  revokeFoundingMembership,
  savePlatformSettings,
  submitPlatformClaim,
} from "@/lib/platform-payments-server";
import { getEffectivePlan } from "@/lib/plans";
import { toPkrRupees, pkrPerUsd } from "@/lib/local-payments";

/**
 * Phase 3 — platform payments (customers paying BizPilot).
 *
 * The rules that must never break:
 *  1. The amount owed is computed on the server; a form cannot set the price.
 *  2. A Founding Member price is locked in the database and *renewals read the lock*,
 *     so raising the catalogue price never raises an existing member's price.
 *  3. Slots are counted, not trusted: the 11th member is a normal customer.
 *  4. Approval moves a subscription exactly once and is audited — self-approval is
 *     allowed but flagged, because a solo founder still has to run their own product.
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

function seedWorkspace(label = "ws", planCode = "starter") {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `${label}-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId,
    `${slug}@example.com`,
    null,
    `${label} owner`,
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
    "owner",
    now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, created_at, updated_at) values (?,?,?,?,?,?,?)",
    [newId(), orgId, planCode, "active", "monthly", now, now]
  );
  return { userId, orgId, slug, email: `${slug}@example.com` };
}

function configurePlatform(overrides: Partial<Parameters<typeof savePlatformSettings>[0]> = {}) {
  savePlatformSettings({
    sadapayNumber: "03001234567",
    jazzcashNumber: null,
    easypaisaNumber: null,
    bankIban: null,
    bankName: null,
    accountHolderName: "Shahab Khan",
    defaultMethod: "sadapay",
    instructions: "Send the exact amount.",
    demoMode: false,
    foundingMemberPriceCents: FOUNDING_MEMBER_DEFAULTS.priceCents,
    foundingMemberSlots: FOUNDING_MEMBER_DEFAULTS.slots,
    foundingMemberMemberLimit: FOUNDING_MEMBER_DEFAULTS.memberLimit,
    actorId: null,
    ...overrides,
  });
}

/* ------------------------------------------------------------- pure rules */

describe("platform settings validation", () => {
  it("refuses a configuration with no payout method at all", () => {
    const problem = validatePlatformSettings({
      accountHolderName: "Shahab Khan",
      defaultMethod: "sadapay",
      demoMode: false,
    });
    expect(problem).toMatch(/at least one payout method/i);
  });

  it("refuses a default method that has no number", () => {
    const problem = validatePlatformSettings({
      sadapayNumber: "03001234567",
      accountHolderName: "Shahab Khan",
      defaultMethod: "jazzcash",
      demoMode: false,
    });
    expect(problem).toMatch(/default method/i);
  });

  it("rejects a malformed wallet number", () => {
    const problem = validatePlatformSettings({
      sadapayNumber: "12",
      accountHolderName: "Shahab Khan",
      defaultMethod: "sadapay",
      demoMode: false,
    });
    expect(problem).toBeTruthy();
  });

  it("requires a bank name when an IBAN is configured", () => {
    const problem = validatePlatformSettings({
      bankIban: "PK36SCBL0000001123456702",
      accountHolderName: "Shahab Khan",
      defaultMethod: "bank",
      demoMode: false,
    });
    expect(problem).toMatch(/bank name/i);
  });

  it("accepts a complete configuration", () => {
    expect(
      validatePlatformSettings({
        sadapayNumber: "03001234567",
        bankIban: "PK36SCBL0000001123456702",
        bankName: "Meezan Bank",
        accountHolderName: "Shahab Khan",
        defaultMethod: "sadapay",
        demoMode: false,
        foundingMemberPricePkr: 1500,
        foundingMemberSlots: 10,
        foundingMemberMemberLimit: 3,
      })
    ).toBeNull();
  });

  it("rejects a Founding price of zero and out-of-range slots", () => {
    const base = { sadapayNumber: "03001234567", accountHolderName: "Shahab Khan", defaultMethod: "sadapay" as const, demoMode: false };
    expect(validatePlatformSettings({ ...base, foundingMemberPricePkr: 0 })).toMatch(/greater than zero/i);
    expect(validatePlatformSettings({ ...base, foundingMemberSlots: -1 })).toMatch(/whole number/i);
    expect(validatePlatformSettings({ ...base, foundingMemberMemberLimit: 0 })).toMatch(/seats/i);
  });
});

describe("platform methods shown to the customer", () => {
  const settings = (over: Partial<PlatformSettings> = {}): PlatformSettings => ({
    ...getPlatformSettings(),
    account_holder_name: "Shahab Khan",
    sadapay_number: "03001234567",
    jazzcash_number: "03007654321",
    easypaisa_number: null,
    bank_iban: null,
    default_method: "jazzcash",
    ...over,
  });

  it("skips empty methods and puts the default first", () => {
    const rows = platformMethods(settings());
    expect(rows.map((row) => row.kind)).toEqual(["jazzcash", "sadapay"]);
  });

  it("treats an unconfigured platform as unusable", () => {
    expect(isPlatformConfigured(settings({ sadapay_number: null, jazzcash_number: null }))).toBe(false);
    expect(isPlatformConfigured(settings())).toBe(true);
  });

  it("creates no row and returns defaults when nobody has configured payouts", () => {
    const current = getPlatformSettings();
    expect(current.sadapay_number).toBeNull();
    expect(current.founding_member_price_cents).toBe(FOUNDING_MEMBER_DEFAULTS.priceCents);
    expect(get<{ c: number }>("select count(*) as c from platform_settings")?.c).toBe(0);
  });
});

describe("claim amount", () => {
  it("quotes the catalogue price in rupees for a normal customer", () => {
    process.env.PKR_PER_USD = "280";
    const cents = resolveClaimAmountCents({
      planMonthlyCents: 1000, // $10
      planAnnualCents: 10000,
      cycle: "monthly",
      founding: null,
    });
    expect(cents).toBe(toPkrRupees(1000, 280) * 100);
    expect(cents).toBe(280000); // Rs 2,800 in paisa
  });

  it("quotes the locked Founding price monthly and 12× annually", () => {
    expect(
      resolveClaimAmountCents({ planMonthlyCents: 9999, planAnnualCents: 99999, cycle: "monthly", founding: { priceCents: 150000 } })
    ).toBe(150000);
    expect(
      resolveClaimAmountCents({ planMonthlyCents: 9999, planAnnualCents: 99999, cycle: "annual", founding: { priceCents: 150000 } })
    ).toBe(1800000);
  });

  it("counts slots down and never below zero", () => {
    expect(foundingSlotsLeft({ founding_member_slots: 10 }, 3)).toBe(7);
    expect(foundingSlotsLeft({ founding_member_slots: 2 }, 5)).toBe(0);
  });

  it("keeps an existing member out of the slot queue", () => {
    expect(isFoundingEligible({ grantedCount: 0, slots: 10, alreadyMember: true })).toBe(false);
    expect(isFoundingEligible({ grantedCount: 10, slots: 10, alreadyMember: false })).toBe(false);
    expect(isFoundingEligible({ grantedCount: 9, slots: 10, alreadyMember: false })).toBe(true);
  });
});

/* ------------------------------------------------------------ claim flow */

describe("submitting a platform claim", () => {
  it("computes the amount server-side, ignoring anything the caller passes", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("claim");
    const result = submitPlatformClaim({
      organizationId: orgId,
      planCode: "starter",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-123456",
      note: null,
      userId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Founding price is quoted because places are open — Rs 1,500, not the catalogue price.
    expect(result.amountCents).toBe(FOUNDING_MEMBER_DEFAULTS.priceCents);
    expect(result.founding).toBe(true);
    const row = get<{ amount_cents: number; currency: string; status: string; founding_member: number }>(
      "select amount_cents, currency, status, founding_member from platform_payment_claims where id = ?",
      [result.claimId]
    );
    expect(row).toMatchObject({ amount_cents: 150000, currency: "PKR", status: "pending", founding_member: 1 });
  });

  it("refuses a second claim while one is pending", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("dup");
    const base = {
      organizationId: orgId,
      planCode: "starter" as const,
      cycle: "monthly" as const,
      methodKind: "sadapay" as const,
      note: null,
      userId,
    };
    expect(submitPlatformClaim({ ...base, reference: "TX-1" }).ok).toBe(true);
    const second = submitPlatformClaim({ ...base, reference: "TX-2" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.message).toMatch(/already have a payment/i);
    expect(openClaimForOrg(orgId)?.reference).toBe("TX-1");
  });

  it("refuses an unknown plan", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("badplan");
    const result = submitPlatformClaim({
      organizationId: orgId,
      planCode: "enterprise-unlimited",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-9",
      note: null,
      userId,
    });
    expect(result.ok).toBe(false);
  });

  it("writes an audit row and a notification for the workspace", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("audit");
    const result = submitPlatformClaim({
      organizationId: orgId,
      planCode: "starter",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-AUDIT",
      note: "paid from Easypaisa",
      userId,
    });
    expect(result.ok).toBe(true);
    const auditRow = get<{ action: string; metadata: string }>(
      "select action, metadata from audit_logs where action = 'platform_payment.submitted' order by created_at desc limit 1"
    );
    expect(auditRow?.action).toBe("platform_payment.submitted");
    const notifications = all<{ title: string }>("select title from notifications where organization_id = ?", [orgId]);
    expect(notifications.some((n) => /payment submitted/i.test(n.title))).toBe(true);
  });
});

describe("approving a platform claim", () => {
  it("activates the plan for the paid period and audits it", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("approve", "starter");
    const submitted = submitPlatformClaim({
      organizationId: orgId,
      planCode: "professional",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-OK",
      note: null,
      userId,
    });
    if (!submitted.ok) throw new Error(submitted.message);

    const outcome = reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: userId, note: "seen in wallet" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.planCode).toBe("professional");
    expect(outcome.selfApproved).toBe(true); // same person submitted and approved
    expect(new Date(outcome.periodEnd).getTime()).toBeGreaterThan(Date.now());

    const sub = get<{ plan_code: string; status: string; billing_cycle: string }>(
      "select plan_code, status, billing_cycle from subscriptions where organization_id = ?",
      [orgId]
    );
    expect(sub).toMatchObject({ plan_code: "professional", status: "active", billing_cycle: "monthly" });

    const auditRow = get<{ metadata: string }>(
      "select metadata from audit_logs where action = 'platform_payment.approved' order by created_at desc limit 1"
    );
    expect(auditRow?.metadata).toContain('"selfApproved":true');
  });

  it("cannot be approved twice (double click, two tabs, two admins)", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("twice");
    const submitted = submitPlatformClaim({
      organizationId: orgId,
      planCode: "professional",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-TWICE",
      note: null,
      userId,
    });
    if (!submitted.ok) throw new Error(submitted.message);
    expect(reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: userId }).ok).toBe(true);
    const again = reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: userId });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.message).toMatch(/already approved/i);
    expect(all("select id from audit_logs where action = 'platform_payment.approved'").length).toBe(1);
  });

  it("records an independent approval as not self-approved", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("indep");
    const reviewer = seedWorkspace("reviewer");
    const submitted = submitPlatformClaim({
      organizationId: orgId,
      planCode: "starter",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-INDEP",
      note: null,
      userId,
    });
    if (!submitted.ok) throw new Error(submitted.message);
    const outcome = reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: reviewer.userId });
    expect(outcome.ok && outcome.selfApproved).toBe(false);
    const row = get<{ self_approved: number }>("select self_approved from platform_payment_claims where id = ?", [submitted.claimId]);
    expect(row?.self_approved).toBe(0);
  });

  it("rejects with a reason the customer can read, and changes nothing else", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("reject", "starter");
    const submitted = submitPlatformClaim({
      organizationId: orgId,
      planCode: "professional",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-BAD",
      note: null,
      userId,
    });
    if (!submitted.ok) throw new Error(submitted.message);
    const outcome = reviewPlatformClaim({
      claimId: submitted.claimId,
      decision: "reject",
      actorId: userId,
      note: "No such transaction ID in my statement.",
    });
    expect(outcome.ok).toBe(false);
    const row = get<{ status: string; review_note: string }>(
      "select status, review_note from platform_payment_claims where id = ?",
      [submitted.claimId]
    );
    expect(row).toMatchObject({ status: "rejected", review_note: "No such transaction ID in my statement." });
    // The workspace keeps whatever plan it had.
    const sub = get<{ plan_code: string; status: string }>("select plan_code, status from subscriptions where organization_id = ?", [orgId]);
    expect(sub).toMatchObject({ plan_code: "starter", status: "active" });
  });

  it("returns a clear error for a claim that does not exist", () => {
    configurePlatform();
    const outcome = reviewPlatformClaim({ claimId: newId(), decision: "approve", actorId: null });
    expect(outcome.ok).toBe(false);
  });
});

/* --------------------------------------------------------- founding members */

describe("Founding Member", () => {
  it("is granted automatically when a founding-priced claim is approved", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("founding");
    const submitted = submitPlatformClaim({
      organizationId: orgId,
      planCode: "starter",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-FOUND",
      note: null,
      userId,
    });
    if (!submitted.ok) throw new Error(submitted.message);
    const outcome = reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: userId });
    expect(outcome.ok && outcome.foundingGranted).toBe(true);

    const member = foundingForOrg(orgId);
    expect(member?.locked_price_cents).toBe(FOUNDING_MEMBER_DEFAULTS.priceCents);
    expect(member?.member_limit).toBe(FOUNDING_MEMBER_DEFAULTS.memberLimit); // 3 seats
    expect(member?.source).toBe("auto");
    expect(foundingGrantedCount()).toBe(1);
  });

  it("gives Starter limits but three seats through the plan resolver", () => {
    configurePlatform();
    const { orgId } = seedWorkspace("limits");
    const before = getEffectivePlan(orgId);
    expect(before.code).toBe("starter");
    expect(grantFoundingMembership({ organizationId: orgId, actorId: null, source: "manual" }).created).toBe(true);
    const after = getEffectivePlan(orgId);
    expect(after.code).toBe(before.code); // no plan upgrade — only seats
    expect(after.lead_limit).toBe(before.lead_limit);
    expect(after.member_limit).toBe(3);
  });

  it("keeps the locked price when the catalogue price rises", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("lock");
    const submitted = submitPlatformClaim({
      organizationId: orgId,
      planCode: "starter",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-LOCK",
      note: null,
      userId,
    });
    if (!submitted.ok) throw new Error(submitted.message);
    reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: userId });

    // The owner doubles every catalogue price afterwards.
    run("update plans set price_monthly_cents = price_monthly_cents * 2, price_annual_cents = price_annual_cents * 2");
    run("update platform_settings set founding_member_price_cents = 300000 where id = 'default'");

    const quote = quoteForClaim(orgId, "starter", "monthly");
    expect(quote?.amountCents).toBe(FOUNDING_MEMBER_DEFAULTS.priceCents); // still Rs 1,500
    expect(quote?.founding).toBe(true);
  });

  it("stops granting once the slots are gone, and the next customer pays full price", () => {
    configurePlatform({ foundingMemberSlots: 1 });
    const first = seedWorkspace("slot-1");
    const second = seedWorkspace("slot-2");

    for (const ws of [first, second]) {
      const submitted = submitPlatformClaim({
        organizationId: ws.orgId,
        planCode: "starter",
        cycle: "monthly",
        methodKind: "sadapay",
        reference: `TX-${ws.slug}`,
        note: null,
        userId: ws.userId,
      });
      if (!submitted.ok) throw new Error(submitted.message);
      reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: ws.userId });
    }

    expect(foundingGrantedCount()).toBe(1);
    expect(foundingForOrg(first.orgId)).toBeTruthy();
    expect(foundingForOrg(second.orgId)).toBeNull();

    // The second workspace is quoted the ordinary catalogue price.
    const quote = quoteForClaim(second.orgId, "starter", "monthly");
    expect(quote?.founding).toBe(false);
    const catalogue = get<{ price_monthly_cents: number }>("select price_monthly_cents from plans where code = 'starter'")!;
    expect(quote?.amountCents).toBe(toPkrRupees(catalogue.price_monthly_cents, pkrPerUsd()) * 100);
  });

  it("does not consume two slots for an existing member", () => {
    configurePlatform();
    const { orgId, userId } = seedWorkspace("once");
    for (const [index, reference] of ["TX-A", "TX-B"].entries()) {
      const submitted = submitPlatformClaim({
        organizationId: orgId,
        planCode: "starter",
        cycle: "monthly",
        methodKind: "sadapay",
        reference,
        note: null,
        userId,
      });
      if (!submitted.ok) throw new Error(submitted.message);
      const outcome = reviewPlatformClaim({ claimId: submitted.claimId, decision: "approve", actorId: userId });
      expect(outcome.ok).toBe(true);
      // The first approval grants the lock; the second must not consume another slot.
      if (outcome.ok) expect(outcome.foundingGranted).toBe(index === 0);
    }
    expect(foundingGrantedCount()).toBe(1);
  });

  it("can be granted and revoked manually, and revoking restores plan seats", () => {
    configurePlatform();
    const { orgId } = seedWorkspace("manual");
    const planSeats = getEffectivePlan(orgId).member_limit;
    grantFoundingMembership({ organizationId: orgId, actorId: null, source: "manual", note: "paid cash" });
    expect(getEffectivePlan(orgId).member_limit).toBe(3);
    expect(revokeFoundingMembership({ organizationId: orgId, actorId: null })).toBe(true);
    expect(foundingForOrg(orgId)).toBeNull();
    expect(getEffectivePlan(orgId).member_limit).toBe(planSeats);
    expect(revokeFoundingMembership({ organizationId: orgId, actorId: null })).toBe(false);
  });
});

/* -------------------------------------------------------------- demo mode */

describe("demo mode", () => {
  it("auto-approves the platform owner's own claim only", () => {
    configurePlatform({ demoMode: true });
    const owner = seedWorkspace("demo-owner");
    const customer = seedWorkspace("demo-customer");

    const ownerClaim = submitPlatformClaim({
      organizationId: owner.orgId,
      planCode: "professional",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-DEMO-1",
      note: null,
      userId: owner.userId,
      isPlatformOwnerWorkspace: true,
    });
    expect(ownerClaim.ok && ownerClaim.autoApproved).toBe(true);
    expect(get<{ status: string }>("select status from subscriptions where organization_id = ?", [owner.orgId])?.status).toBe("active");
    const flagged = get<{ self_approved: number; review_note: string }>(
      "select self_approved, review_note from platform_payment_claims where organization_id = ?",
      [owner.orgId]
    );
    expect(flagged?.self_approved).toBe(1);
    expect(flagged?.review_note).toMatch(/demo_mode/i);

    const customerClaim = submitPlatformClaim({
      organizationId: customer.orgId,
      planCode: "professional",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-DEMO-2",
      note: null,
      userId: customer.userId,
      isPlatformOwnerWorkspace: false,
    });
    expect(customerClaim.ok && customerClaim.autoApproved).toBe(false);
    expect(openClaimForOrg(customer.orgId)?.status).toBe("pending");
  });

  it("does nothing when demo mode is off", () => {
    configurePlatform({ demoMode: false });
    const owner = seedWorkspace("nodemo");
    const result = submitPlatformClaim({
      organizationId: owner.orgId,
      planCode: "professional",
      cycle: "monthly",
      methodKind: "sadapay",
      reference: "TX-NODEMO",
      note: null,
      userId: owner.userId,
      isPlatformOwnerWorkspace: true,
    });
    expect(result.ok && result.autoApproved).toBe(false);
    expect(openClaimForOrg(owner.orgId)).toBeTruthy();
  });
});

/* ------------------------------------------------------------------- queue */

describe("admin queue", () => {
  it("lists pending claims with the workspace name, newest first", () => {
    configurePlatform();
    const a = seedWorkspace("queue-a");
    const b = seedWorkspace("queue-b");
    for (const ws of [a, b]) {
      submitPlatformClaim({
        organizationId: ws.orgId,
        planCode: "starter",
        cycle: "monthly",
        methodKind: "sadapay",
        reference: `TX-${ws.slug}`,
        note: null,
        userId: ws.userId,
      });
    }
    const pending = listAllClaims("pending");
    expect(pending.length).toBe(2);
    expect(pending[0]?.organization_name).toBeTruthy();
    expect(pending.every((claim) => claim.status === "pending")).toBe(true);
  });

  it("keeps the settings numbers in the database, not in the source", () => {
    configurePlatform({ sadapayNumber: "03119998887" });
    const row = get<{ sadapay_number: string; account_holder_name: string }>(
      "select sadapay_number, account_holder_name from platform_settings where id = 'default'"
    );
    expect(row).toMatchObject({ sadapay_number: "03119998887", account_holder_name: "Shahab Khan" });
    // Saving twice updates the single row rather than inserting a second one.
    configurePlatform({ demoMode: true });
    expect(get<{ c: number }>("select count(*) as c from platform_settings")?.c).toBe(1);
    expect(getPlatformSettings().demo_mode).toBe(1);
  });
});
