import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { all, get, run, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { POST as paymentWebhook } from "@/app/api/payments/webhook/[provider]/route";
import {
  normalizeReference,
  rupeesToCents,
  paisaToCents,
  statusFromWord,
  safeEqual,
} from "@/lib/payments/provider";
import { sadapayProvider } from "@/lib/payments/sadapay";
import { jazzcashSecureHash, jazzcashProvider } from "@/lib/payments/jazzcash";
import { easypaisaHash, easypaisaProvider } from "@/lib/payments/easypaisa";
import { loadProvider, providerStatuses, anyProviderConfigured } from "@/lib/payments/registry";
import { approveLocalPaymentRequest, findOrganizationByReference } from "@/lib/payments/approve";
import { paymentReference, validateRefund, isFullyRefunded } from "@/lib/local-payments";

/**
 * Real-gateway rails: signature verification, idempotency, amount matching and the
 * shared approval path. Every test here runs against the actual route handler and
 * the actual database — nothing is stubbed except the provider's secret.
 */

const SADAPAY_SECRET = "sada_whsec_test_123";

function resetEnv() {
  delete process.env.SADAPAY_WEBHOOK_SECRET;
  delete process.env.SADAPAY_SIGNATURE_HEADER;
  delete process.env.JAZZCASH_INTEGRITY_SALT;
  delete process.env.EASYPAISA_HASH_KEY;
}

beforeEach(() => {
  resetDatabaseForTests();
  resetEnv();
});

/* ------------------------------------------------------------------ pure rules */

describe("provider helpers", () => {
  it("normalises a transfer note the way a human types it", () => {
    expect(normalizeReference("  bp-acme  ")).toBe("BP-ACME");
    expect(normalizeReference("BP ACME")).toBe("BPACME");
    expect(normalizeReference("ab")).toBeNull();
    expect(normalizeReference(null)).toBeNull();
  });

  it("converts rupees to paisa without float drift", () => {
    expect(rupeesToCents("12500")).toBe(1_250_000);
    expect(rupeesToCents("12500.50")).toBe(1_250_050);
    expect(rupeesToCents("12,500")).toBe(1_250_000);
    expect(rupeesToCents("abc")).toBe(0);
    expect(rupeesToCents("")).toBe(0);
  });

  it("keeps a paisa field as paisa", () => {
    expect(paisaToCents("2220000")).toBe(2_220_000);
    expect(paisaToCents("22200.5")).toBe(0); // paisa is an integer; never round a payment
  });

  it("maps status words onto paid / failed / ignored", () => {
    expect(statusFromWord("Paid")).toBe("paid");
    expect(statusFromWord("succeeded")).toBe("paid");
    expect(statusFromWord("COMPLETED")).toBe("paid");
    expect(statusFromWord("declined")).toBe("failed");
    expect(statusFromWord("weird-state")).toBe("ignored");
    expect(statusFromWord(null)).toBe("ignored");
  });

  it("compares signatures in constant time without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(false);
  });
});

describe("transfer notes", () => {
  it("keeps two workspaces with the same prefix apart", () => {
    // Truncation alone made these identical, which is how money lands on the wrong
    // workspace. The digest suffix is what fixes it.
    expect(paymentReference("ali-store-1")).not.toBe(paymentReference("ali-store-2"));
    expect(paymentReference("alpha-1795811662722")).not.toBe(paymentReference("alpha-1795811662723"));
  });

  it("still looks like something a human can type into a bank app", () => {
    expect(paymentReference("acme-traders")).toMatch(/^BP-[A-Z0-9]{1,8}-[A-Z0-9]{4}$/);
    expect(paymentReference("")).toMatch(/^BP-WORKSPACE-[A-Z0-9]{4}$/);
    expect(paymentReference("acme-traders")).toBe(paymentReference("acme-traders"));
  });

  it("has no collisions across 5,000 generated workspaces", () => {
    const notes = new Set<string>();
    for (let i = 0; i < 5000; i += 1) notes.add(paymentReference(`shop-${i}-store`));
    expect(notes.size).toBe(5000);
  });
});

describe("refund rules", () => {
  it("refuses a refund larger than what is left on the payment", () => {
    expect(validateRefund({ paidCents: 2_220_000, alreadyRefundedCents: 0, amountCents: 2_220_100 })).toContain("Only Rs");
    expect(validateRefund({ paidCents: 2_220_000, alreadyRefundedCents: 1_000_000, amountCents: 1_500_000 })).toContain(
      "Only Rs 12,200"
    );
  });

  it("refuses a zero, negative or non-numeric refund", () => {
    expect(validateRefund({ paidCents: 1000, alreadyRefundedCents: 0, amountCents: 0 })).toContain("greater than zero");
    expect(validateRefund({ paidCents: 1000, alreadyRefundedCents: 0, amountCents: -500 })).toContain("greater than zero");
    expect(validateRefund({ paidCents: 1000, alreadyRefundedCents: 0, amountCents: Number.NaN })).toContain("greater than zero");
  });

  it("refuses to refund the same money twice, and allows a partial one", () => {
    expect(validateRefund({ paidCents: 1000, alreadyRefundedCents: 1000, amountCents: 100 })).toContain("already been fully refunded");
    expect(validateRefund({ paidCents: 1000, alreadyRefundedCents: 400, amountCents: 600 })).toBeNull();
  });

  it("knows exactly when access has to stop", () => {
    expect(isFullyRefunded(2_220_000, 2_220_000)).toBe(true);
    expect(isFullyRefunded(2_220_000, 2_219_900)).toBe(false);
    expect(isFullyRefunded(0, 0)).toBe(false);
  });
});

/* -------------------------------------------------------------------- sadapay */

describe("sadapay adapter", () => {
  function signed(body: string, secret = SADAPAY_SECRET) {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  it("reports itself unconfigured without a secret", () => {
    const result = sadapayProvider.verifyWebhook("{}", new Headers());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
    expect(sadapayProvider.isConfigured()).toBe(false);
  });

  it("rejects a body whose signature was made with another secret", () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const body = JSON.stringify({ payment_id: "pay_1", status: "paid", amount: 8200 });
    const result = sadapayProvider.verifyWebhook(body, new Headers({ "x-sadapay-signature": signed(body, "wrong") }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("accepts a valid signature, including the sha256= prefix", () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const body = JSON.stringify({
      payment_id: "pay_abc",
      status: "paid",
      amount: "22200",
      reference: "bp-acme",
      currency: "pkr",
    });
    const result = sadapayProvider.verifyWebhook(body, new Headers({ "x-sadapay-signature": `sha256=${signed(body)}` }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.paymentId).toBe("pay_abc");
      expect(result.event.status).toBe("paid");
      expect(result.event.amountCents).toBe(2_220_000); // rupees → paisa
      expect(result.event.reference).toBe("BP-ACME");
      expect(result.event.currency).toBe("PKR");
    }
  });

  it("honours a configurable signature header", () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    process.env.SADAPAY_SIGNATURE_HEADER = "x-custom-sig";
    const body = JSON.stringify({ payment_id: "pay_h", status: "paid", amount: 100 });
    const ok = sadapayProvider.verifyWebhook(body, new Headers({ "x-custom-sig": signed(body) }));
    expect(ok.ok).toBe(true);
    const old = sadapayProvider.verifyWebhook(body, new Headers({ "x-sadapay-signature": signed(body) }));
    expect(old.ok).toBe(false);
  });

  it("treats a malformed body as a 400, not a crash", () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const body = "not-json";
    const result = sadapayProvider.verifyWebhook(body, new Headers({ "x-sadapay-signature": signed(body) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });
});

/* ------------------------------------------------------------ jazzcash/easypaisa */

describe("jazzcash adapter", () => {
  const salt = "jc_salt_test";
  const params = {
    pp_TxnRefNo: "T2026080912345",
    pp_Amount: "2220000", // paisa
    pp_BillReference: "BP-ACME",
    pp_ResponseCode: "000",
  };

  it("verifies its documented salt-prefixed sorted hash", () => {
    process.env.JAZZCASH_INTEGRITY_SALT = salt;
    const hash = jazzcashSecureHash(params, salt);
    const body = new URLSearchParams({ ...params, pp_SecureHash: hash }).toString();
    const result = jazzcashProvider.verifyWebhook(body, new Headers());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.status).toBe("paid");
      expect(result.event.amountCents).toBe(2_220_000);
      expect(result.event.reference).toBe("BP-ACME");
    }
  });

  it("rejects a tampered amount", () => {
    process.env.JAZZCASH_INTEGRITY_SALT = salt;
    const hash = jazzcashSecureHash(params, salt);
    const body = new URLSearchParams({ ...params, pp_Amount: "1", pp_SecureHash: hash }).toString();
    const result = jazzcashProvider.verifyWebhook(body, new Headers());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("treats a non-000 response code as a failed payment, never a paid one", () => {
    process.env.JAZZCASH_INTEGRITY_SALT = salt;
    const failed = { ...params, pp_ResponseCode: "157" };
    const body = new URLSearchParams({ ...failed, pp_SecureHash: jazzcashSecureHash(failed, salt) }).toString();
    const result = jazzcashProvider.verifyWebhook(body, new Headers());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.status).toBe("failed");
  });
});

describe("easypaisa adapter", () => {
  const key = "ep_key_test";

  it("verifies a signed callback and converts rupee amounts", () => {
    process.env.EASYPAISA_HASH_KEY = key;
    const params = { orderId: "EP-1", transactionId: "TX-9", amount: "41800", status: "Paid", billReference: "BP-ACME" };
    const body = new URLSearchParams({ ...params, hash: easypaisaHash(params, key) }).toString();
    const result = easypaisaProvider.verifyWebhook(body, new Headers());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.paymentId).toBe("TX-9");
      expect(result.event.amountCents).toBe(4_180_000);
      expect(result.event.status).toBe("paid");
    }
  });

  it("refuses an unsigned callback", () => {
    process.env.EASYPAISA_HASH_KEY = key;
    const body = new URLSearchParams({ orderId: "EP-2", transactionId: "TX-10", amount: "100", status: "Paid" }).toString();
    const result = easypaisaProvider.verifyWebhook(body, new Headers());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });
});

describe("registry", () => {
  it("knows the three providers and refuses anything else", () => {
    expect(loadProvider("sadapay")?.name).toBe("sadapay");
    expect(loadProvider("jazzcash")?.name).toBe("jazzcash");
    expect(loadProvider("easypaisa")?.name).toBe("easypaisa");
    expect(loadProvider("stripe")).toBeNull();
    expect(loadProvider("")).toBeNull();
  });

  it("tells the truth about what is configured", () => {
    expect(anyProviderConfigured()).toBe(false);
    expect(providerStatuses().every((s) => !s.configured)).toBe(true);
    process.env.SADAPAY_WEBHOOK_SECRET = "x";
    expect(anyProviderConfigured()).toBe(true);
    expect(providerStatuses().find((s) => s.name === "sadapay")?.configured).toBe(true);
  });
});

/* ------------------------------------------------------------ webhook route (DB) */

/** One workspace, one payout account, one pending claim of Rs 22,200. */
function seedClaim(options: { amountCents?: number; pending?: boolean } = {}) {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `gw-${newToken(4).toLowerCase()}`;
  const amountCents = options.amountCents ?? 2_220_000;

  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId,
    `${slug}@test.com`,
    null,
    "Gateway Owner",
    now,
    now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [
    orgId,
    "Gateway Org",
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
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, "starter", "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  const methodId = newId();
  run(
    `insert into local_payment_methods (id, organization_id, kind, account_title, account_number, is_active, created_by, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?)`,
    [methodId, orgId, "sadapay", "Gateway Owner", "03001234567", 1, userId, now, now]
  );

  let requestId: string | null = null;
  if (options.pending !== false) {
    requestId = newId();
    run(
      `insert into local_payment_requests (id, organization_id, method_id, plan_code, billing_cycle, amount_cents, currency, reference, status, submitted_by, submitted_at)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
      [requestId, orgId, methodId, "professional", "monthly", amountCents, "PKR", `BP-${slug.toUpperCase()}`, "pending", userId, now]
    );
  }

  return { orgId, userId, slug, requestId, methodId, reference: paymentReference(slug) };
}

function sadapayRequest(body: string, secret = SADAPAY_SECRET) {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("http://localhost/api/payments/webhook/sadapay", {
    method: "POST",
    headers: { "content-type": "application/json", "x-sadapay-signature": signature },
    body,
  });
}

const params = (provider: string) => ({ params: Promise.resolve({ provider }) });

describe("payment webhook route", () => {
  it("404s an unknown provider", async () => {
    const res = await paymentWebhook(new Request("http://localhost/api/payments/webhook/paypal", { method: "POST" }), params("paypal"));
    expect(res.status).toBe(404);
  });

  it("503s when the provider has no secret, and touches nothing", async () => {
    const { requestId } = seedClaim();
    const body = JSON.stringify({ payment_id: "pay_x", status: "paid", amount: 22200 });
    const res = await paymentWebhook(sadapayRequest(body), params("sadapay"));
    expect(res.status).toBe(503);
    expect(get<{ status: string }>("select status from local_payment_requests where id = ?", [requestId!])?.status).toBe("pending");
  });

  it("401s a bad signature and leaves the claim pending", async () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const { requestId } = seedClaim();
    const body = JSON.stringify({ payment_id: "pay_y", status: "paid", amount: 22200 });
    const res = await paymentWebhook(sadapayRequest(body, "wrong-secret"), params("sadapay"));
    expect(res.status).toBe(401);
    expect(get<{ status: string }>("select status from local_payment_requests where id = ?", [requestId!])?.status).toBe("pending");
  });

  it("approves the claim and activates the plan on a verified payment", async () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const { orgId, requestId, reference } = seedClaim();
    const body = JSON.stringify({ payment_id: "pay_ok_1", status: "paid", amount: "22200", reference });

    const res = await paymentWebhook(sadapayRequest(body), params("sadapay"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { action: string };
    expect(json.action).toBe("approved");

    const request = get<{ status: string; gateway_provider: string; gateway_payment_id: string; paid_at: string | null }>(
      "select status, gateway_provider, gateway_payment_id, paid_at from local_payment_requests where id = ?",
      [requestId!]
    );
    expect(request?.status).toBe("approved");
    expect(request?.gateway_provider).toBe("sadapay");
    expect(request?.gateway_payment_id).toBe("pay_ok_1");
    expect(request?.paid_at).toBeTruthy();

    const sub = get<{ plan_code: string; status: string; current_period_end: string }>(
      "select plan_code, status, current_period_end from subscriptions where organization_id = ?",
      [orgId]
    );
    expect(sub?.plan_code).toBe("professional");
    expect(sub?.status).toBe("active");
    expect(new Date(sub!.current_period_end).getTime()).toBeGreaterThan(Date.now());

    // The audit row names the gateway, and the notification exists for the owner.
    const auditRow = get<{ action: string; metadata: string }>(
      "select action, metadata from audit_logs where organization_id = ? and action = 'local_payment.approved'",
      [orgId]
    );
    expect(auditRow?.action).toBe("local_payment.approved");
    expect(auditRow?.metadata).toContain("sadapay:pay_ok_1");
    expect(all<{ id: string }>("select id from notifications where organization_id = ?", [orgId]).length).toBeGreaterThan(0);
  });

  it("is idempotent: a replayed webhook does not extend the plan twice", async () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const { orgId, reference } = seedClaim();
    const body = JSON.stringify({ payment_id: "pay_replay", status: "paid", amount: "22200", reference });

    const first = await paymentWebhook(sadapayRequest(body), params("sadapay"));
    expect(((await first.json()) as { action: string }).action).toBe("approved");
    const afterFirst = get<{ current_period_end: string }>(
      "select current_period_end from subscriptions where organization_id = ?",
      [orgId]
    )?.current_period_end;

    const second = await paymentWebhook(sadapayRequest(body), params("sadapay"));
    const secondJson = (await second.json()) as { duplicate?: boolean };
    expect(secondJson.duplicate).toBe(true);
    const afterSecond = get<{ current_period_end: string }>(
      "select current_period_end from subscriptions where organization_id = ?",
      [orgId]
    )?.current_period_end;
    expect(afterSecond).toBe(afterFirst);
    expect(all<{ id: string }>("select id from webhook_events where provider = 'sadapay'").length).toBe(1);
  });

  it("never auto-approves when the amount does not match the claim", async () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const { orgId, requestId, reference } = seedClaim();
    // A Rs 1 transfer must not unlock a Rs 22,200 plan.
    const body = JSON.stringify({ payment_id: "pay_small", status: "paid", amount: "1", reference });

    const res = await paymentWebhook(sadapayRequest(body), params("sadapay"));
    const json = (await res.json()) as { action: string };
    expect(json.action).toBe("amount_mismatch");
    expect(get<{ status: string }>("select status from local_payment_requests where id = ?", [requestId!])?.status).toBe("pending");
    expect(get<{ plan_code: string }>("select plan_code from subscriptions where organization_id = ?", [orgId])?.plan_code).toBe("starter");
    expect(
      all<{ id: string }>("select id from audit_logs where organization_id = ? and action = 'local_payment.amount_mismatch'", [orgId]).length
    ).toBe(1);
  });

  it("does not guess a workspace when the transfer note matches none", async () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    seedClaim();
    const body = JSON.stringify({ payment_id: "pay_orphan", status: "paid", amount: "22200", reference: "BP-NOBODY" });
    const res = await paymentWebhook(sadapayRequest(body), params("sadapay"));
    expect(((await res.json()) as { action: string }).action).toBe("unmatched");
    expect(all<{ id: string }>("select id from local_payment_requests where status = 'approved'").length).toBe(0);
  });

  it("records a failed payment without closing the claim", async () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const { requestId, reference } = seedClaim();
    const body = JSON.stringify({ payment_id: "pay_fail", status: "declined", amount: "22200", reference });
    const res = await paymentWebhook(sadapayRequest(body), params("sadapay"));
    expect(((await res.json()) as { action: string }).action).toBe("ignored");
    expect(get<{ status: string }>("select status from local_payment_requests where id = ?", [requestId!])?.status).toBe("pending");
  });

  it("rejects an oversized payload before reading it", async () => {
    process.env.SADAPAY_WEBHOOK_SECRET = SADAPAY_SECRET;
    const request = new Request("http://localhost/api/payments/webhook/sadapay", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(200 * 1024) },
      body: "{}",
    });
    const res = await paymentWebhook(request, params("sadapay"));
    expect(res.status).toBe(413);
  });

  it("resolves the transfer note back to its workspace", () => {
    const { orgId, reference } = seedClaim();
    expect(findOrganizationByReference(reference)?.id).toBe(orgId);
    expect(findOrganizationByReference("BP-NOBODY")).toBeNull();
    expect(findOrganizationByReference(null)).toBeNull();
  });
});

describe("shared approval path", () => {
  it("refuses a second approval of the same claim", () => {
    const { orgId, requestId } = seedClaim();
    const first = approveLocalPaymentRequest({ organizationId: orgId, requestId: requestId!, actorId: null });
    expect(first.ok).toBe(true);
    const second = approveLocalPaymentRequest({ organizationId: orgId, requestId: requestId!, actorId: null });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toContain("already");
  });

  it("refuses a claim from another workspace", () => {
    const mine = seedClaim();
    const theirs = seedClaim();
    const outcome = approveLocalPaymentRequest({
      organizationId: mine.orgId,
      requestId: theirs.requestId!,
      actorId: null,
    });
    expect(outcome.ok).toBe(false);
  });
});
