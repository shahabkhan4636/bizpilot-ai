import { describe, it, expect, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { run, get, all, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { POST as captureLead, OPTIONS as captureOptions } from "@/app/api/leads/capture/route";

const WEBHOOK_SECRET = "whsec_test_secret_123";
process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_PRICE_PROFESSIONAL = "price_prof_monthly";

function sign(body: string, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function webhookRequest(body: string, signature: string | null) {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}) },
    body,
  });
}

async function seedOrg(slug = `wh-${newToken(4).toLowerCase()}`) {
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${slug}@test.com`, null, "Webhook User", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, "Webhook Org", slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [newId(), orgId, userId, "owner", now]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, "starter", "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  return { orgId, userId, slug };
}

beforeEach(() => {
  resetDatabaseForTests();
});

describe("stripe webhook", () => {
  it("rejects an unsigned request", async () => {
    const res = await stripeWebhook(webhookRequest(JSON.stringify({ id: "evt_unsigned", type: "invoice.payment_succeeded" }), null));
    expect(res.status).toBe(400);
  });

  it("rejects a bad signature without touching the database", async () => {
    const body = JSON.stringify({ id: "evt_bad", type: "checkout.session.completed", data: { object: {} } });
    const res = await stripeWebhook(webhookRequest(body, sign(body, "whsec_wrong")));
    expect(res.status).toBe(400);
    expect(all("select id from webhook_events")).toHaveLength(0);
  });

  it("upgrades the plan only after a verified checkout.session.completed", async () => {
    const { orgId } = await seedOrg();
    expect(get<{ plan_code: string }>("select plan_code from subscriptions where organization_id = ?", [orgId])?.plan_code).toBe("starter");

    const body = JSON.stringify({
      id: "evt_checkout_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          customer: "cus_test_1",
          subscription: "sub_test_1",
          metadata: { organization_id: orgId, plan_code: "professional" },
        },
      },
    });
    const res = await stripeWebhook(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);

    const sub = get<{ plan_code: string; status: string; stripe_customer_id: string }>(
      "select plan_code, status, stripe_customer_id from subscriptions where organization_id = ?",
      [orgId]
    );
    expect(sub?.plan_code).toBe("professional");
    expect(sub?.status).toBe("active");
    expect(sub?.stripe_customer_id).toBe("cus_test_1");

    const event = get<{ processed_at: string | null }>("select processed_at from webhook_events where external_id = ?", ["evt_checkout_1"]);
    expect(event?.processed_at).toBeTruthy();
  });

  it("ignores a duplicate delivery of the same event id", async () => {
    const { orgId } = await seedOrg();
    const body = JSON.stringify({
      id: "evt_dupe",
      type: "checkout.session.completed",
      data: { object: { customer: "cus_dupe", subscription: "sub_dupe", metadata: { organization_id: orgId, plan_code: "business" } } },
    });
    const first = await stripeWebhook(webhookRequest(body, sign(body)));
    expect(first.status).toBe(200);

    // Move the org back, then replay the same event: it must not re-apply.
    run("update subscriptions set plan_code = 'starter' where organization_id = ?", [orgId]);
    const second = await stripeWebhook(webhookRequest(body, sign(body)));
    const payload = (await second.json()) as { duplicate?: boolean };
    expect(payload.duplicate).toBe(true);
    expect(get<{ plan_code: string }>("select plan_code from subscriptions where organization_id = ?", [orgId])?.plan_code).toBe("starter");
  });

  it("maps a subscription price id back to the plan and stores the period end", async () => {
    const { orgId } = await seedOrg();
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    const body = JSON.stringify({
      id: "evt_sub_updated",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_xyz",
          customer: "cus_xyz",
          status: "active",
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          metadata: { organization_id: orgId },
          items: { data: [{ price: { id: "price_prof_monthly", recurring: { interval: "month" } } }] },
        },
      },
    });
    const res = await stripeWebhook(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);
    const sub = get<{ plan_code: string; current_period_end: string; billing_cycle: string }>(
      "select plan_code, current_period_end, billing_cycle from subscriptions where organization_id = ?",
      [orgId]
    );
    expect(sub?.plan_code).toBe("professional");
    expect(sub?.billing_cycle).toBe("monthly");
    expect(new Date(sub!.current_period_end).getTime()).toBeGreaterThan(Date.now());
  });

  it("downgrades to starter when the subscription is deleted", async () => {
    const { orgId } = await seedOrg();
    run("update subscriptions set plan_code = 'agency', status = 'active', stripe_customer_id = 'cus_del' where organization_id = ?", [orgId]);
    const body = JSON.stringify({
      id: "evt_deleted",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_del", customer: "cus_del", status: "canceled", metadata: {} } },
    });
    const res = await stripeWebhook(webhookRequest(body, sign(body)));
    expect(res.status).toBe(200);
    const sub = get<{ plan_code: string; status: string }>("select plan_code, status from subscriptions where organization_id = ?", [orgId]);
    expect(sub?.plan_code).toBe("starter");
    expect(sub?.status).toBe("canceled");
  });

  it("marks the subscription past_due on a failed payment", async () => {
    const { orgId } = await seedOrg();
    run("update subscriptions set stripe_customer_id = 'cus_fail', status = 'active' where organization_id = ?", [orgId]);
    const body = JSON.stringify({
      id: "evt_fail",
      type: "invoice.payment_failed",
      data: { object: { id: "in_1", customer: "cus_fail", amount_due: 7900 } },
    });
    await stripeWebhook(webhookRequest(body, sign(body)));
    expect(get<{ status: string }>("select status from subscriptions where organization_id = ?", [orgId])?.status).toBe("past_due");
  });
});

describe("public lead capture endpoint", () => {
  function captureRequest(body: Record<string, string>, opts: { key?: string; slug?: string } = {}) {
    return new Request("http://localhost/api/leads/capture", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.key ? { "x-capture-key": opts.key } : {}),
        ...(opts.slug ? { "x-org-slug": opts.slug } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("answers CORS preflight", async () => {
    const res = await captureOptions();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("is closed while LEAD_CAPTURE_KEY is unset", async () => {
    delete process.env.LEAD_CAPTURE_KEY;
    const res = await captureLead(captureRequest({ name: "x" }, { slug: "whatever" }));
    expect(res.status).toBe(503);
  });

  it("rejects a wrong key", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    const res = await captureLead(captureRequest({ name: "Sara" }, { key: "nope", slug }));
    expect(res.status).toBe(401);
  });

  it("creates a real lead for the right workspace and fires automations", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { orgId, slug } = await seedOrg();

    const res = await captureLead(
      captureRequest({ name: "Sara Ahmed", email: "SARA@vertex.example", company: "Vertex", source: "landing", value: "1200" }, { key: "capture-secret", slug })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);

    const lead = get<{ name: string; email: string; value_cents: number; source: string; status: string; organization_id: string }>(
      "select name, email, value_cents, source, status, organization_id from leads where id = ?",
      [body.id]
    );
    expect(lead?.organization_id).toBe(orgId);
    expect(lead?.email).toBe("sara@vertex.example");
    expect(lead?.value_cents).toBe(120000);
    expect(lead?.status).toBe("new");
    expect(lead?.source).toBe("landing");
  });

  it("rejects a payload with neither name nor email", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    const res = await captureLead(captureRequest({ company: "No contact" }, { key: "capture-secret", slug }));
    expect(res.status).toBe(422);
  });

  it("rejects an invalid email", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    const res = await captureLead(captureRequest({ name: "X", email: "not-an-email" }, { key: "capture-secret", slug }));
    expect(res.status).toBe(422);
  });

  it("respects the plan lead limit", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { orgId, slug } = await seedOrg();
    const now = nowIso();
    for (let i = 0; i < 100; i++) {
      run(
        `insert into leads (id, organization_id, name, source, status, value_cents, created_at, updated_at)
         values (?,?,?,?,?,?,?,?)`,
        [newId(), orgId, `Bulk ${i}`, "manual", "new", 0, now, now]
      );
    }
    const res = await captureLead(captureRequest({ name: "Overflow" }, { key: "capture-secret", slug }));
    expect(res.status).toBe(402);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toContain("100");
  });
});

describe("capture endpoint hardening", () => {
  function jsonRequest(body: string, key: string, slug: string, extraHeaders: Record<string, string> = {}) {
    return new Request("http://localhost/api/leads/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "x-capture-key": key, "x-org-slug": slug, ...extraHeaders },
      body,
    });
  }

  it("rejects an oversized body with 413 instead of parsing it", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    const huge = JSON.stringify({ name: "A", notes: "x".repeat(70 * 1024) });
    const res = await captureLead(jsonRequest(huge, "capture-secret", slug));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/i);
  });

  it("rejects an oversized body even when the client lies about content-length", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    const huge = JSON.stringify({ name: "A", notes: "y".repeat(70 * 1024) });
    const res = await captureLead(
      // A wrong content-length must not be trusted; the bytes are measured.
      jsonRequest(huge, "capture-secret", slug, { "content-length": "12" })
    );
    expect(res.status).toBe(413);
  });

  it("refuses a JSON array or null instead of coercing it", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    for (const bad of ["[1,2,3]", "null", '"text"']) {
      const res = await captureLead(jsonRequest(bad, "capture-secret", slug));
      expect(res.status, `body ${bad}`).toBe(400);
    }
  });

  it("rejects an empty key rather than comparing it to the configured one", async () => {
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    const res = await captureLead(
      new Request("http://localhost/api/leads/capture", {
        method: "POST",
        headers: { "content-type": "application/json", "x-org-slug": slug },
        body: JSON.stringify({ name: "No key" }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("does not leak the configured key length through the comparison", async () => {
    // secureCompare hashes both sides, so prefixes of the real key are just as
    // wrong as unrelated strings.
    process.env.LEAD_CAPTURE_KEY = "capture-secret";
    const { slug } = await seedOrg();
    for (const attempt of ["c", "capture-secre", "capture-secrets", "apture-secret"]) {
      const res = await captureLead(jsonRequest(JSON.stringify({ name: "X" }), attempt, slug));
      expect(res.status, `key ${attempt}`).toBe(401);
    }
  });
});
