"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { get, run } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { listPlans } from "@/lib/plans";
import { createCheckoutSession, createBillingPortalSession, isStripeConfigured, stripePriceId } from "@/lib/stripe";

export type BillingState = { error?: string; notice?: string } | null;

async function origin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("host") ?? "localhost:3000";
  return process.env.NEXT_PUBLIC_APP_URL ?? `${proto}://${host}`;
}

/**
 * Starts a Stripe Checkout session. Access is NOT granted here — only a
 * verified `checkout.session.completed` / `customer.subscription.*` webhook
 * updates the local subscription row.
 */
export async function startCheckoutAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  let url: string | null = null;
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    if (membership.role !== "owner" && membership.role !== "admin") {
      return { error: "Only an owner or admin can change the subscription." };
    }
    if (!isStripeConfigured()) {
      return { error: "Stripe is not configured on this deployment. Add STRIPE_SECRET_KEY and the four price IDs to enable checkout." };
    }

    const planCode = String(form.get("plan_code") ?? "");
    const cycle = String(form.get("cycle") ?? "monthly") === "annual" ? "annual" : "monthly";
    const plan = listPlans().find((p) => p.code === planCode);
    if (!plan) return { error: "Unknown plan." };

    const priceId = stripePriceId(planCode, cycle);
    if (!priceId) return { error: `No Stripe price ID is configured for the ${plan.name} plan.` };

    const base = await origin();
    const session = await createCheckoutSession({
      priceId,
      organizationId: orgId,
      customerEmail: user.email,
      successUrl: `${base}/billing?checkout=returned`,
      cancelUrl: `${base}/billing?checkout=cancelled`,
      trialDays: 0,
    });
    if (!session.ok) return { error: session.message };

    audit({ organizationId: orgId, actorId: user.id, action: "billing.checkout_started", metadata: { planCode, cycle } });
    url = session.url;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not start checkout." };
  }
  redirect(url);
}

export async function openPortalAction(_prev: BillingState): Promise<BillingState> {
  let url: string | null = null;
  try {
    const { membership } = await requireAuth();
    const orgId = membership.organization_id;
    if (membership.role !== "owner" && membership.role !== "admin") {
      return { error: "Only an owner or admin can open the billing portal." };
    }
    const sub = get<{ stripe_customer_id: string | null }>(
      "select stripe_customer_id from subscriptions where organization_id = ?",
      [orgId]
    );
    if (!isStripeConfigured()) return { error: "Stripe is not configured on this deployment." };
    if (!sub?.stripe_customer_id) return { error: "No Stripe customer exists yet — start a checkout first." };

    const base = await origin();
    const session = await createBillingPortalSession({ customerId: sub.stripe_customer_id, returnUrl: `${base}/billing` });
    if (!session.ok) return { error: session.message };
    url = session.url;
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not open the billing portal." };
  }
  redirect(url);
}

/** Owner-only local downgrade to the free starter limits (no Stripe call). */
export async function cancelSubscriptionAction(_prev: BillingState, form: FormData): Promise<BillingState> {
  try {
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;
    if (membership.role !== "owner") return { error: "Only the workspace owner can cancel the subscription." };
    if (form.get("confirm") !== "on") return { error: "Tick the confirmation box to cancel." };

    run(
      "update subscriptions set status = 'canceled', cancel_at_period_end = 0, updated_at = ? where organization_id = ?",
      [new Date().toISOString(), orgId]
    );
    audit({ organizationId: orgId, actorId: user.id, action: "billing.cancelled_locally" });
    return {
      notice:
        "Marked as cancelled locally. If a Stripe subscription is still active, cancel it in the billing portal too so you are not charged again.",
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not cancel." };
  }
}
