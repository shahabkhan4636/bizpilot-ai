import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { verifyStripeSignature, planCodeFromPriceId, isStripeConfigured } from "@/lib/stripe";
import { setPlanForOrg, listPlans } from "@/lib/plans";
import { audit } from "@/lib/audit";
import { dispatchTrigger } from "@/lib/automations";

export const dynamic = "force-dynamic";

const ALLOWED_STATUSES = new Set(["trialing", "active", "past_due", "canceled", "incomplete", "unpaid"]);

type StripeObject = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strFrom(obj: StripeObject, key: string): string | null {
  return str(obj[key]);
}

function cycleFromPriceObject(price: unknown): "monthly" | "annual" {
  const recurring = (price as { recurring?: { interval?: string } } | null)?.recurring;
  return recurring?.interval === "year" ? "annual" : "monthly";
}

/**
 * Stripe webhook. Two guarantees:
 *  1. The signature is verified against the raw body — unsigned requests are rejected.
 *  2. Every event id is stored once (unique provider+external_id), so retries are no-ops.
 * Access is only granted here, never from a success page.
 */
export async function POST(request: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe is not configured on this deployment" }, { status: 503 });
  }

  const raw = await request.text();
  const signature = request.headers.get("stripe-signature");
  const verified = verifyStripeSignature(raw, signature);

  if (!verified.ok) {
    return NextResponse.json({ error: `Invalid signature: ${verified.message}` }, { status: 400 });
  }

  const event = verified.event;
  const existing = get<{ id: string; processed_at: string | null }>(
    "select id, processed_at from webhook_events where provider = 'stripe' and external_id = ?",
    [event.id]
  );

  // Already handled: acknowledge without re-running side effects.
  if (existing?.processed_at) {
    return NextResponse.json({ received: true, duplicate: true, id: event.id });
  }

  const eventId = existing?.id ?? newId();
  if (!existing) {
    try {
      run(
        "insert into webhook_events (id, provider, external_id, event_type, payload, processed_at, error, created_at) values (?,?,?,?,?,?,?,?)",
        [eventId, "stripe", event.id, event.type, raw.slice(0, 20000), null, null, nowIso()]
      );
    } catch {
      // Unique constraint race: another delivery of the same event won. Treat as duplicate.
      return NextResponse.json({ received: true, duplicate: true, id: event.id });
    }
  }

  const object = (event.data?.object ?? {}) as StripeObject;
  let error: string | null = null;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const orgId = strFrom((object.metadata ?? {}) as StripeObject, "organization_id");
        const customerId = strFrom(object, "customer");
        const subscriptionId = strFrom(object, "subscription");
        if (!orgId) throw new Error("checkout.session.completed without metadata.organization_id");
        const planCode = strFrom((object.metadata ?? {}) as StripeObject, "plan_code") ?? "starter";
        const validPlan = listPlans().some((p) => p.code === planCode) ? planCode : "starter";
        setPlanForOrg(orgId, validPlan, {
          status: "active",
          stripeCustomerId: customerId ?? undefined,
          stripeSubscriptionId: subscriptionId ?? undefined,
        });
        audit({ organizationId: orgId, action: "stripe.checkout_completed", metadata: { planCode: validPlan } });
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const orgId = strFrom((object.metadata ?? {}) as StripeObject, "organization_id");
        const customerId = strFrom(object, "customer");
        const subscriptionId = strFrom(object, "id");
        const statusRaw = strFrom(object, "status") ?? "incomplete";
        const status = ALLOWED_STATUSES.has(statusRaw) ? statusRaw : "incomplete";
        const priceId = (((object.items as StripeObject | undefined)?.data as StripeObject[] | undefined)?.[0]?.price as StripeObject | undefined)?.id as string | undefined;
        const planCode = planCodeFromPriceId(priceId) ?? "starter";
        const cycle = cycleFromPriceObject(
          (((object.items as StripeObject | undefined)?.data as StripeObject[] | undefined)?.[0] as StripeObject | undefined)?.price
        );

        let targetOrg = orgId;
        if (!targetOrg && customerId) {
          targetOrg = get<{ organization_id: string }>(
            "select organization_id from subscriptions where stripe_customer_id = ?",
            [customerId]
          )?.organization_id ?? null;
        }
        if (!targetOrg) throw new Error(`${event.type} could not be linked to an organisation`);

        setPlanForOrg(targetOrg, planCode, {
          status,
          stripeCustomerId: customerId ?? undefined,
          stripeSubscriptionId: subscriptionId ?? undefined,
          billingCycle: cycle,
        });
        run(
          "update subscriptions set stripe_price_id = ?, current_period_end = ?, cancel_at_period_end = ? where organization_id = ?",
          [
            priceId ?? null,
            object.current_period_end ? new Date(Number(object.current_period_end) * 1000).toISOString() : null,
            object.cancel_at_period_end ? 1 : 0,
            targetOrg,
          ]
        );
        audit({ organizationId: targetOrg, action: `stripe.${event.type}`, metadata: { planCode, status } });
        break;
      }

      case "customer.subscription.deleted": {
        const customerId = strFrom(object, "customer");
        const orgId =
          strFrom((object.metadata ?? {}) as StripeObject, "organization_id") ??
          (customerId ? get<{ organization_id: string }>("select organization_id from subscriptions where stripe_customer_id = ?", [customerId])?.organization_id : null);
        if (!orgId) throw new Error("customer.subscription.deleted could not be linked to an organisation");
        setPlanForOrg(orgId, "starter", { status: "canceled", stripeCustomerId: customerId ?? undefined });
        run("update subscriptions set cancel_at_period_end = 1 where organization_id = ?", [orgId]);
        audit({ organizationId: orgId, action: "stripe.subscription_deleted" });
        break;
      }

      case "invoice.payment_succeeded":
      case "invoice.payment_failed": {
        const customerId = strFrom(object, "customer");
        const orgId = customerId
          ? get<{ organization_id: string }>("select organization_id from subscriptions where stripe_customer_id = ?", [customerId])?.organization_id ?? null
          : null;
        if (orgId) {
          if (event.type === "invoice.payment_failed") {
            run("update subscriptions set status = 'past_due', updated_at = ? where organization_id = ?", [nowIso(), orgId]);
          } else {
            run("update subscriptions set status = 'active', updated_at = ? where organization_id = ?", [nowIso(), orgId]);
          }
          audit({ organizationId: orgId, action: `stripe.${event.type}` });
          try {
            await dispatchTrigger(
              orgId,
              event.type === "invoice.payment_succeeded" ? "subscription.payment_succeeded" : "subscription.payment_failed",
              { type: "subscription", id: strFrom(object, "id") ?? "invoice", data: { amount_paid: object.amount_paid, amount_due: object.amount_due } },
              {}
            );
          } catch { /* automation failures must not fail the webhook */ }
        }
        break;
      }

      default:
        // Acknowledge unhandled event types so Stripe stops retrying them.
        run("update webhook_events set processed_at = ? where id = ?", [nowIso(), eventId]);
        return NextResponse.json({ received: true, handled: false, type: event.type });
    }

    run("update webhook_events set processed_at = ?, error = null where id = ?", [nowIso(), eventId]);
    return NextResponse.json({ received: true, handled: true, type: event.type });
  } catch (e) {
    error = e instanceof Error ? e.message : "Unknown webhook error";
    run("update webhook_events set error = ?, processed_at = ? where id = ?", [error, nowIso(), eventId]);
    logger.error("stripe webhook failed", { eventId, error });
    // 500 so Stripe retries with backoff.
    return NextResponse.json({ received: false, error }, { status: 500 });
  }
}
