import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal, dependency-free Stripe client (REST + webhook signature verification).
 * Without STRIPE_SECRET_KEY everything reports `not_configured` — paid access is
 * never granted from a frontend "success" page, only from verified webhooks.
 */

export function isStripeConfigured(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? "").trim().length > 0;
}

export function stripePriceId(planCode: string, cycle: "monthly" | "annual"): string | null {
  const map: Record<string, string | undefined> = {
    starter: process.env.STRIPE_PRICE_STARTER,
    professional: process.env.STRIPE_PRICE_PROFESSIONAL,
    business: process.env.STRIPE_PRICE_BUSINESS,
    agency: process.env.STRIPE_PRICE_AGENCY,
  };
  const base = map[planCode];
  if (!base) return null;
  return cycle === "annual" ? `${base}_annual` : base;
}

async function stripeRequest<T>(path: string, body: Record<string, string>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key) return { ok: false, message: "Stripe is not configured. Add STRIPE_SECRET_KEY." };
  try {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `Stripe error ${res.status}: ${detail.slice(0, 240)}` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Stripe request failed" };
  }
}

export async function createCheckoutSession(input: {
  priceId: string;
  organizationId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
}): Promise<{ ok: true; url: string; id: string } | { ok: false; message: string }> {
  const body: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": "1",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer_email: input.customerEmail,
    "metadata[organization_id]": input.organizationId,
    "subscription_data[metadata][organization_id]": input.organizationId,
    allow_promotion_codes: "true",
  };
  if (input.trialDays && input.trialDays > 0) {
    body["subscription_data[trial_period_days]"] = String(input.trialDays);
  }
  const res = await stripeRequest<{ id: string; url: string }>("checkout/sessions", body);
  if (!res.ok) return res;
  return { ok: true, url: res.data.url, id: res.data.id };
}

export async function createBillingPortalSession(input: {
  customerId: string;
  returnUrl: string;
}): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const res = await stripeRequest<{ url: string }>("billing_portal/sessions", {
    customer: input.customerId,
    return_url: input.returnUrl,
  });
  if (!res.ok) return res;
  return { ok: true, url: res.data.url };
}

/* ------------------------------------------------------------------ */
/* Webhook signature verification                                      */
/* ------------------------------------------------------------------ */

export type WebhookVerification =
  | { ok: true; event: { id: string; type: string; data: { object: Record<string, unknown> } } }
  | { ok: false; message: string };

/**
 * Verifies the Stripe-Signature header: `t=<timestamp>,v1=<hex hmac>` where the
 * HMAC-SHA256 is computed over `${timestamp}.${rawBody}`.
 */
export function verifyStripeSignature(rawBody: string, signatureHeader: string | null, secretOverride?: string): WebhookVerification {
  const secret = secretOverride ?? process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret) return { ok: false, message: "STRIPE_WEBHOOK_SECRET is not configured" };
  if (!signatureHeader) return { ok: false, message: "Missing Stripe-Signature header" };

  const parts = signatureHeader.split(",").reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split("=");
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});

  const timestamp = parts["t"];
  const provided = parts["v1"];
  if (!timestamp || !provided) return { ok: false, message: "Malformed Stripe-Signature header" };

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return { ok: false, message: "Webhook timestamp outside tolerance" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, message: "Invalid webhook signature" };

  try {
    const event = JSON.parse(rawBody) as { id: string; type: string; data: { object: Record<string, unknown> } };
    if (!event.id || !event.type) return { ok: false, message: "Webhook payload missing id/type" };
    return { ok: true, event };
  } catch {
    return { ok: false, message: "Webhook payload is not valid JSON" };
  }
}

export function planCodeFromPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  const map: Record<string, string> = {};
  for (const code of ["starter", "professional", "business", "agency"]) {
    const id = stripePriceId(code, "monthly");
    const annual = stripePriceId(code, "annual");
    if (id) map[id] = code;
    if (annual) map[annual] = code;
  }
  const normalised = priceId.replace(/_annual$/, "");
  return map[priceId] ?? map[normalised] ?? null;
}
