"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { all, get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { requireAuth } from "@/lib/auth";
import { forbiddenRedirect, requirePermission } from "@/lib/authz";
import { audit, logActivity } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { ValidationError, money, oneOf, optionalStr, str } from "@/lib/validate";
import {
  LOCAL_METHOD_KINDS,
  LOCAL_METHOD_LABEL,
  type BillingCycle,
  type LocalMethodKind,
  periodEndFrom,
  validateLocalMethod,
  validatePaymentLink,
} from "@/lib/local-payments";
import { BILLING_CYCLES } from "@/lib/local-payments";

export type LocalPaymentState = { error?: string; notice?: string } | null;

function fail(e: unknown): LocalPaymentState {
  if (e instanceof ValidationError) return { error: e.message };
  if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
  if (e instanceof Error) return { error: e.message };
  return { error: "Something went wrong. Nothing was saved." };
}

/* ------------------------------------------------------------ payout accounts */

/** Owner/admin adds or updates where customers should send money. */
export async function saveLocalMethodAction(_prev: LocalPaymentState, form: FormData): Promise<LocalPaymentState> {
  try {
    await requirePermission("settings:workspace");
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;

    const kind = oneOf<LocalMethodKind>(form.get("kind"), "Payment method", LOCAL_METHOD_KINDS);
    const accountTitle = str(form.get("account_title"), "Account title", { required: true, min: 3, max: 120 });
    const accountNumber = str(form.get("account_number"), "Account number", { required: true, min: 4, max: 60 });
    const label = optionalStr(form.get("label"), 60) || null;
    const paymentLink = optionalStr(form.get("payment_link"), 300) || null;
    const instructions = optionalStr(form.get("instructions"), 500) || null;

    const problem = validateLocalMethod({ kind, accountTitle, accountNumber, paymentLink });
    if (problem) throw new ValidationError(problem);
    const linkProblem = validatePaymentLink(paymentLink);
    if (linkProblem) throw new ValidationError(linkProblem);

    const existingId = optionalStr(form.get("method_id"), 60);
    const now = nowIso();
    if (existingId) {
      const existing = get<{ id: string }>(
        "select id from local_payment_methods where id = ? and organization_id = ?",
        [existingId, orgId]
      );
      if (!existing) throw new ValidationError("That payment method does not belong to this workspace.");
      run(
        `update local_payment_methods
            set kind = ?, label = ?, account_title = ?, account_number = ?, payment_link = ?, instructions = ?, updated_at = ?
          where id = ? and organization_id = ?`,
        [kind, label, accountTitle, accountNumber, paymentLink, instructions, now, existingId, orgId]
      );
      audit({ organizationId: orgId, actorId: user.id, action: "payment_method.updated", targetType: "local_payment_method", targetId: existingId, metadata: { kind } });
    } else {
      const id = newId();
      run(
        `insert into local_payment_methods
           (id, organization_id, kind, label, account_title, account_number, payment_link, instructions,
            is_active, created_by, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, orgId, kind, label, accountTitle, accountNumber, paymentLink, instructions, 1, user.id, now, now]
      );
      audit({ organizationId: orgId, actorId: user.id, action: "payment_method.created", targetType: "local_payment_method", targetId: id, metadata: { kind } });
      logActivity({
        organizationId: orgId, actorId: user.id, entityType: "organization", entityId: orgId,
        action: "payment_method.created", summary: `Added ${LOCAL_METHOD_LABEL[kind]} as a payment method`,
      });
    }

    revalidatePath("/billing/local");
    return { notice: `${LOCAL_METHOD_LABEL[kind]} details saved. Customers can now pay into it.` };
  } catch (e) {
    return fail(e);
  }
}

export async function toggleLocalMethodAction(form: FormData): Promise<void> {
  try {
    await requirePermission("settings:workspace");
  } catch {
    forbiddenRedirect("settings:workspace");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const methodId = String(form.get("method_id") ?? "");
  const row = get<{ id: string; is_active: number }>(
    "select id, is_active from local_payment_methods where id = ? and organization_id = ?",
    [methodId, orgId]
  );
  if (!row) redirect("/billing/local");
  run("update local_payment_methods set is_active = ?, updated_at = ? where id = ? and organization_id = ?", [
    row!.is_active ? 0 : 1, nowIso(), methodId, orgId,
  ]);
  audit({ organizationId: orgId, actorId: user.id, action: row!.is_active ? "payment_method.disabled" : "payment_method.enabled", targetType: "local_payment_method", targetId: methodId });
  revalidatePath("/billing/local");
  redirect("/billing/local");
}

export async function deleteLocalMethodAction(form: FormData): Promise<void> {
  try {
    await requirePermission("settings:workspace");
  } catch {
    forbiddenRedirect("settings:workspace");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;
  const methodId = String(form.get("method_id") ?? "");
  const row = get<{ id: string; kind: string }>(
    "select id, kind from local_payment_methods where id = ? and organization_id = ?",
    [methodId, orgId]
  );
  if (!row) redirect("/billing/local");
  run("delete from local_payment_methods where id = ? and organization_id = ?", [methodId, orgId]);
  audit({ organizationId: orgId, actorId: user.id, action: "payment_method.deleted", targetType: "local_payment_method", targetId: methodId, metadata: { kind: row!.kind } });
  revalidatePath("/billing/local");
  redirect("/billing/local");
}

/* ------------------------------------------------------------- payment claims */

/**
 * The customer/owner says "I sent the money, here is the reference".
 *
 * This never activates anything on its own. Approving is a separate, audited human
 * decision — the whole point of the manual flow is that nobody pretends a transfer
 * was confirmed when no gateway confirmed it.
 */
export async function submitLocalPaymentAction(_prev: LocalPaymentState, form: FormData): Promise<LocalPaymentState> {
  try {
    await requirePermission("billing:manage");
    const { user, membership } = await requireAuth();
    const orgId = membership.organization_id;

    const planCode = str(form.get("plan_code"), "Plan", { required: true, max: 40 });
    const cycle = oneOf<BillingCycle>(form.get("billing_cycle"), "Billing cycle", BILLING_CYCLES, "monthly");
    const methodId = str(form.get("method_id"), "Payment method", { required: true, max: 60 });
    const reference = str(form.get("reference"), "Transaction ID / reference", { required: true, min: 3, max: 120 });
    const note = optionalStr(form.get("payer_note"), 500) || null;
    // Amounts are rupees; `money()` returns minor units, so the form asks for rupees.
    const amountCents = money(form.get("amount_pkr"), "Amount sent");
    if (amountCents <= 0) throw new ValidationError("Amount sent must be greater than zero.");

    const plan = get<{ code: string }>("select code from plans where code = ? and is_active = 1", [planCode]);
    if (!plan) throw new ValidationError("That plan is not available.");
    const method = get<{ id: string; kind: string; is_active: number }>(
      "select id, kind, is_active from local_payment_methods where id = ? and organization_id = ?",
      [methodId, orgId]
    );
    if (!method || !method.is_active) throw new ValidationError("That payment method is not available.");

    // One open claim at a time: a double submit would otherwise look like two payments.
    const openClaim = get<{ id: string }>(
      "select id from local_payment_requests where organization_id = ? and status = 'pending'",
      [orgId]
    );
    if (openClaim) {
      return { error: "You already have a payment waiting for approval. It will be reviewed before you submit another." };
    }

    const id = newId();
    const now = nowIso();
    run(
      `insert into local_payment_requests
         (id, organization_id, method_id, plan_code, billing_cycle, amount_cents, currency, reference, payer_note,
          status, submitted_by, submitted_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, orgId, methodId, planCode, cycle, amountCents, "PKR", reference, note, "pending", user.id, now]
    );

    notify({
      organizationId: orgId,
      type: "approval.pending",
      level: "info",
      title: "Local payment submitted",
      body: `${reference} · Rs ${(amountCents / 100).toLocaleString()} — waiting for approval on /billing/local`,
      href: "/billing/local",
    });
    audit({ organizationId: orgId, actorId: user.id, action: "local_payment.submitted", targetType: "local_payment_request", targetId: id, metadata: { planCode, cycle, methodKind: method.kind } });
    logActivity({
      organizationId: orgId, actorId: user.id, entityType: "organization", entityId: orgId,
      action: "local_payment.submitted", summary: `Payment submitted (${reference}) for the ${planCode} plan`,
    });

    revalidatePath("/billing/local");
    revalidatePath("/notifications");
    return { notice: "Payment submitted. Once it is approved the plan activates automatically and you will get a notification." };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Owner/admin confirms the money actually arrived, which activates the plan.
 *
 * Deliberately a separate step with its own audit entry: the reviewer, the amount
 * and the reference are recorded together, so "who upgraded this workspace and why"
 * is answerable months later.
 */
export async function reviewLocalPaymentAction(form: FormData): Promise<void> {
  try {
    await requirePermission("billing:manage");
  } catch {
    forbiddenRedirect("billing:manage");
  }
  const { user, membership } = await requireAuth();
  const orgId = membership.organization_id;

  const requestId = String(form.get("request_id") ?? "");
  const decision = String(form.get("decision") ?? "");
  const reviewNote = optionalStr(form.get("review_note"), 300) || null;
  if (decision !== "approve" && decision !== "reject") redirect("/billing/local");

  const request = get<{
    id: string; plan_code: string; billing_cycle: BillingCycle; amount_cents: number; status: string; reference: string | null;
  }>(
    "select id, plan_code, billing_cycle, amount_cents, status, reference from local_payment_requests where id = ? and organization_id = ?",
    [requestId, orgId]
  );
  if (!request || request.status !== "pending") redirect("/billing/local");

  const now = nowIso();

  if (decision === "reject") {
    run(
      `update local_payment_requests set status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
        where id = ? and organization_id = ? and status = 'pending'`,
      [user.id, now, reviewNote, requestId, orgId]
    );
    audit({ organizationId: orgId, actorId: user.id, action: "local_payment.rejected", targetType: "local_payment_request", targetId: requestId, metadata: { reviewNote } });
    notify({
      organizationId: orgId, type: "system", level: "warning",
      title: "Payment not approved",
      body: reviewNote ?? "The submitted payment could not be verified.",
      href: "/billing/local",
    });
    revalidatePath("/billing/local");
    redirect("/billing/local");
  }

  // Approval is conditional on the request still being pending, so two reviewers
  // (or a double-click) cannot extend the subscription twice.
  const changed = run(
    `update local_payment_requests set status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?
      where id = ? and organization_id = ? and status = 'pending'`,
    [user.id, now, reviewNote, requestId, orgId]
  );
  if (changed.changes === 0) redirect("/billing/local");

  const periodEnd = periodEndFrom(request.billing_cycle, new Date());
  const existing = get<{ id: string }>("select id from subscriptions where organization_id = ?", [orgId]);
  if (existing) {
    run(
      `update subscriptions set plan_code = ?, status = 'active', billing_cycle = ?, current_period_end = ?,
              cancel_at_period_end = 0, trial_ends_at = null, updated_at = ?
        where organization_id = ?`,
      [request.plan_code, request.billing_cycle, periodEnd, now, orgId]
    );
  } else {
    run(
      `insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, current_period_end, created_at, updated_at)
       values (?,?,?,?,?,?,?,?)`,
      [newId(), orgId, request.plan_code, "active", request.billing_cycle, periodEnd, now, now]
    );
  }

  audit({
    organizationId: orgId, actorId: user.id, action: "local_payment.approved", targetType: "local_payment_request",
    targetId: requestId, metadata: { planCode: request.plan_code, cycle: request.billing_cycle, amountCents: request.amount_cents, reference: request.reference },
  });
  logActivity({
    organizationId: orgId, actorId: user.id, entityType: "organization", entityId: orgId,
    action: "local_payment.approved",
    summary: `Payment approved — ${request.plan_code} (${request.billing_cycle}) active until ${periodEnd.slice(0, 10)}`,
  });
  notify({
    organizationId: orgId, type: "system", level: "success",
    title: `Plan activated: ${request.plan_code}`,
    body: `Your payment was approved. The plan runs until ${periodEnd.slice(0, 10)}.`,
    href: "/billing",
  });

  revalidatePath("/billing");
  revalidatePath("/billing/local");
  revalidatePath("/notifications");
  redirect("/billing/local");
}

/** Numbers shown on the page; kept here so the page does not build its own SQL. */
export async function listLocalPaymentData(orgId: string) {
  return {
    methods: all<{ id: string; kind: string; label: string | null; account_title: string; account_number: string; payment_link: string | null; instructions: string | null; is_active: number }>(
      "select id, kind, label, account_title, account_number, payment_link, instructions, is_active from local_payment_methods where organization_id = ? order by created_at",
      [orgId]
    ),
    requests: all<{ id: string; plan_code: string; billing_cycle: string; amount_cents: number; currency: string; reference: string | null; payer_note: string | null; status: string; submitted_at: string; reviewed_at: string | null; review_note: string | null }>(
      `select id, plan_code, billing_cycle, amount_cents, currency, reference, payer_note, status,
              submitted_at, reviewed_at, review_note
         from local_payment_requests where organization_id = ? order by submitted_at desc limit 25`,
      [orgId]
    ),
  };
}
