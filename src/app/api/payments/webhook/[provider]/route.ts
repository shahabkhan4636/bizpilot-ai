import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { audit, logActivity } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { loadProvider } from "@/lib/payments/registry";
import {
  approveLocalPaymentRequest,
  findOrganizationsByReference,
  findPendingRequest,
} from "@/lib/payments/approve";

/**
 * Real gateway callbacks for the local (Pakistan) rails.
 *
 *   POST /api/payments/webhook/sadapay
 *   POST /api/payments/webhook/jazzcash
 *   POST /api/payments/webhook/easypaisa
 *
 * This is the "automatic" version of the manual flow on `/billing/local`. It exists
 * so that a merchant account can be switched on without rewriting anything:
 *
 *  1. Unknown provider → 404. No secret configured → 503. Bad signature → 401.
 *     Nothing in the body is trusted before the signature matches.
 *  2. The body is capped at 64 KB, so a huge payload cannot be used to exhaust
 *     memory in a serverless function.
 *  3. Idempotency is the provider's own payment id in `webhook_events`
 *     (unique on provider + external_id). A replayed webhook is acknowledged, and
 *     does nothing twice.
 *  4. An amount that does not match the claim is NOT approved — it is recorded as a
 *     mismatch and a human has to look at it. Auto-activating on a Rs 1 transfer
 *     would be a bug, not a feature.
 *  5. Approval reuses `approveLocalPaymentRequest`, the same code path the manual
 *     button uses, with `actorId = null` and the gateway id in the audit row.
 */

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

type Outcome = { action: string; detail?: string };

function eventId(provider: string, paymentId: string): string {
  return `${provider}:${paymentId}`;
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider: providerName } = await context.params;

  const provider = loadProvider(providerName);
  if (!provider) {
    return NextResponse.json({ error: `Unknown payment provider: ${providerName}` }, { status: 404 });
  }
  if (!provider.isConfigured()) {
    return NextResponse.json(
      {
        error: `${provider.name} webhooks are not configured on this deployment`,
        detail: `Set ${provider.requiredEnv.join(", ")} before pointing ${provider.name} at this route.`,
      },
      { status: 503 }
    );
  }

  // Declared length is checked before reading, and the actual length again after —
  // a missing header must not become an unbounded read.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const verified = provider.verifyWebhook(raw, request.headers);
  if (!verified.ok) {
    logger.warn("payment webhook rejected", { provider: provider.name, status: verified.status, reason: verified.message });
    return NextResponse.json({ error: verified.message }, { status: verified.status });
  }
  const event = verified.event;

  const external = eventId(provider.name, event.paymentId);
  const seen = get<{ id: string; processed_at: string | null }>(
    "select id, processed_at from webhook_events where provider = ? and external_id = ?",
    [provider.name, external]
  );
  if (seen?.processed_at) {
    return NextResponse.json({ received: true, duplicate: true, id: external });
  }
  const rowId = seen?.id ?? newId();
  const now = nowIso();
  if (!seen) {
    run(
      `insert into webhook_events (id, provider, external_id, event_type, payload, processed_at, created_at)
       values (?,?,?,?,?,?,?)`,
      [rowId, provider.name, external, event.status, JSON.stringify(event.summary), now, now]
    );
  }

  const finish = (outcome: Outcome, status = 200) => {
    run("update webhook_events set processed_at = ?, error = ? where id = ?", [
      nowIso(),
      outcome.action === "approved" || outcome.action === "duplicate" ? null : outcome.detail ?? outcome.action,
      rowId,
    ]);
    return NextResponse.json({ received: true, ...outcome }, { status });
  };

  if (event.status !== "paid") {
    // A failed/cancelled payment is recorded, never acted on: the claim stays open
    // for a real payment instead of being closed by a failed attempt.
    audit({
      organizationId: null,
      actorId: null,
      action: `payment_webhook.${event.status}`,
      targetType: "payment_provider",
      targetId: event.paymentId,
      metadata: { provider: provider.name, ...event.summary },
    });
    return finish({ action: "ignored", detail: `status: ${event.status}` });
  }

  const candidates = findOrganizationsByReference(event.reference);
  if (candidates.length > 1) {
    // Never guess: two workspaces cannot both own one transfer note.
    logger.error("payment webhook: transfer note is ambiguous", {
      provider: provider.name,
      reference: event.reference,
      matches: candidates.length,
    });
    return finish({
      action: "ambiguous_reference",
      detail: `Transfer note ${event.reference} matches ${candidates.length} workspaces`,
    });
  }
  const organization = candidates[0] ?? null;
  if (!organization) {
    logger.warn("payment webhook: no workspace matches the transfer note", {
      provider: provider.name,
      reference: event.reference,
    });
    return finish({
      action: "unmatched",
      detail: `No workspace matches transfer note ${event.reference ?? "(empty)"}`,
    });
  }

  const pending = findPendingRequest(organization.id);
  if (!pending) {
    return finish({
      action: "no_pending_request",
      detail: "The payment arrived but this workspace has no claim waiting for approval",
    });
  }

  if (event.amountCents > 0 && event.amountCents !== pending.amount_cents) {
    audit({
      organizationId: organization.id,
      actorId: null,
      action: "local_payment.amount_mismatch",
      targetType: "local_payment_request",
      targetId: pending.id,
      metadata: { provider: provider.name, expectedCents: pending.amount_cents, receivedCents: event.amountCents, paymentId: event.paymentId },
    });
    notify({
      organizationId: organization.id,
      type: "system",
      level: "warning",
      title: "Payment amount does not match",
      body: `Rs ${(event.amountCents / 100).toLocaleString()} arrived for a claim of Rs ${(pending.amount_cents / 100).toLocaleString()}. It was not approved automatically — review it on /billing/local.`,
      href: "/billing/local",
    });
    logActivity({
      organizationId: organization.id,
      actorId: null,
      entityType: "organization",
      entityId: organization.id,
      action: "local_payment.amount_mismatch",
      summary: `Payment of Rs ${(event.amountCents / 100).toLocaleString()} did not match the claim of Rs ${(pending.amount_cents / 100).toLocaleString()}`,
    });
    return finish({ action: "amount_mismatch", detail: "Amount did not match the claim" });
  }

  const result = approveLocalPaymentRequest({
    organizationId: organization.id,
    requestId: pending.id,
    actorId: null,
    note: `Auto-approved by ${provider.name} payment ${event.paymentId}`,
    gateway: { provider: provider.name, paymentId: event.paymentId },
  });

  if (!result.ok) {
    return finish({ action: "not_approved", detail: result.message });
  }

  logger.info("payment webhook approved a plan", {
    provider: provider.name,
    organizationId: organization.id,
    planCode: result.planCode,
    periodEnd: result.periodEnd,
  });
  return finish({ action: "approved" });
}
