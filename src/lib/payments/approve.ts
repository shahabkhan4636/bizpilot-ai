import { all, get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { audit, logActivity } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { periodEndFrom, paymentReference, type BillingCycle } from "@/lib/local-payments";

/**
 * The one place where money becomes access.
 *
 * Both entry points — the owner pressing "Approve" and a verified gateway webhook —
 * call `approveLocalPaymentRequest`, so the two can never drift apart: same
 * conditional update (a request can only be approved once), same subscription
 * write, same audit entry, same notification.
 *
 * `actorId` is null for a webhook approval, because no human approved it; the
 * audit row carries the gateway name and payment id instead, which is the honest
 * record of *why* the plan turned on.
 */

export type PendingRequestRow = {
  id: string;
  plan_code: string;
  billing_cycle: BillingCycle;
  amount_cents: number;
  currency: string;
  status: string;
  reference: string | null;
};

export type ApproveInput = {
  organizationId: string;
  requestId: string;
  actorId: string | null;
  note?: string | null;
  gateway?: { provider: string; paymentId: string } | null;
};

export type ApproveOutcome =
  | { ok: true; planCode: string; billingCycle: BillingCycle; periodEnd: string; amountCents: number }
  | { ok: false; message: string };

export function getRequest(organizationId: string, requestId: string): PendingRequestRow | undefined {
  return get<PendingRequestRow>(
    `select id, plan_code, billing_cycle, amount_cents, currency, status, reference
       from local_payment_requests where id = ? and organization_id = ?`,
    [requestId, organizationId]
  );
}

/**
 * Approves a pending claim and activates the plan.
 *
 * The approval is conditional on `status = 'pending'`: two reviewers, a double
 * click, or a webhook arriving after a manual approval all collapse into one
 * activation instead of extending the subscription twice.
 */
export function approveLocalPaymentRequest(input: ApproveInput): ApproveOutcome {
  const request = getRequest(input.organizationId, input.requestId);
  if (!request) return { ok: false, message: "That payment request does not belong to this workspace." };
  if (request.status !== "pending") {
    return { ok: false, message: `That payment is already ${request.status}.` };
  }

  const now = nowIso();
  const changed = run(
    `update local_payment_requests
        set status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?,
            gateway_provider = coalesce(?, gateway_provider),
            gateway_payment_id = coalesce(?, gateway_payment_id),
            paid_at = ?
      where id = ? and organization_id = ? and status = 'pending'`,
    [
      input.actorId,
      now,
      input.note ?? null,
      input.gateway?.provider ?? null,
      input.gateway?.paymentId ?? null,
      now,
      input.requestId,
      input.organizationId,
    ]
  );
  if (changed.changes === 0) {
    return { ok: false, message: "That payment was already reviewed by someone else." };
  }

  const periodEnd = periodEndFrom(request.billing_cycle, new Date());
  const existing = get<{ id: string }>("select id from subscriptions where organization_id = ?", [input.organizationId]);
  if (existing) {
    run(
      `update subscriptions set plan_code = ?, status = 'active', billing_cycle = ?, current_period_end = ?,
              cancel_at_period_end = 0, trial_ends_at = null, updated_at = ?
        where organization_id = ?`,
      [request.plan_code, request.billing_cycle, periodEnd, now, input.organizationId]
    );
  } else {
    run(
      `insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, current_period_end, created_at, updated_at)
       values (?,?,?,?,?,?,?,?)`,
      [newId(), input.organizationId, request.plan_code, "active", request.billing_cycle, periodEnd, now, now]
    );
  }

  const via = input.gateway ? `${input.gateway.provider}:${input.gateway.paymentId}` : "manual approval";
  audit({
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "local_payment.approved",
    targetType: "local_payment_request",
    targetId: input.requestId,
    metadata: {
      planCode: request.plan_code,
      cycle: request.billing_cycle,
      amountCents: request.amount_cents,
      reference: request.reference,
      via,
    },
  });
  logActivity({
    organizationId: input.organizationId,
    actorId: input.actorId,
    entityType: "organization",
    entityId: input.organizationId,
    action: "local_payment.approved",
    summary: `Payment approved (${via}) — ${request.plan_code} (${request.billing_cycle}) active until ${periodEnd.slice(0, 10)}`,
  });
  notify({
    organizationId: input.organizationId,
    type: "system",
    level: "success",
    title: `Plan activated: ${request.plan_code}`,
    body: `Your payment was approved (${via}). The plan runs until ${periodEnd.slice(0, 10)}.`,
    href: "/billing",
  });

  return {
    ok: true,
    planCode: request.plan_code,
    billingCycle: request.billing_cycle,
    periodEnd,
    amountCents: request.amount_cents,
  };
}

/**
 * Maps a transfer note (`BP-ACME`) back to the workspace that owns it.
 *
 * The note is what the customer types into their bank app, so it is compared after
 * the same normalisation on both sides — and it is generated by `paymentReference`
 * rather than parsed, which keeps the two functions from ever disagreeing.
 */
export function findOrganizationsByReference(reference: string | null): { id: string; slug: string }[] {
  if (!reference) return [];
  const rows = all<{ id: string; slug: string }>("select id, slug from organizations");
  return rows.filter((row) => paymentReference(row.slug) === reference);
}

/**
 * Resolves a transfer note to exactly one workspace, or to none.
 *
 * If two workspaces ever produced the same note, guessing would send one customer's
 * money into another customer's plan, so ambiguity is reported as "no match" and a
 * human has to look. That is the only safe answer.
 */
export function findOrganizationByReference(reference: string | null): { id: string; slug: string } | null {
  const matches = findOrganizationsByReference(reference);
  return matches.length === 1 ? matches[0]! : null;
}

/** The claim a webhook is allowed to settle: the single open one for that workspace. */
export function findPendingRequest(organizationId: string): PendingRequestRow | undefined {
  return get<PendingRequestRow>(
    `select id, plan_code, billing_cycle, amount_cents, currency, status, reference
       from local_payment_requests
      where organization_id = ? and status = 'pending'
      order by submitted_at desc limit 1`,
    [organizationId]
  );
}
