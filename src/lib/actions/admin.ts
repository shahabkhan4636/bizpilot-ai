"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { run, get } from "@/lib/db";
import { nowIso } from "@/lib/utils";
import { requireSuperAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { dispatchQueuedEmails, deliverEmail } from "@/lib/email-outbox";
import { emailFromAddress } from "@/lib/email";
import { ValidationError, str, int, optionalStr, email as emailField } from "@/lib/validate";

export type AdminState = { error?: string; notice?: string } | null;

function handle(e: unknown): AdminState {
  if (e instanceof ValidationError) return { error: e.message };
  return { error: e instanceof Error ? e.message : "Unexpected error." };
}

/** Super-admin only. Prices and limits are data, so they change without a deploy. */
export async function updatePlanAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  try {
    const admin = await requireSuperAdmin();
    const code = str(form.get("code"), "Plan code", { min: 2, max: 40 });
    const plan = get<{ code: string }>("select code from plans where code = ?", [code]);
    if (!plan) return { error: "Plan not found." };

    const name = str(form.get("name"), "Plan name", { min: 2, max: 60 });
    const monthly = int(form.get("price_monthly_cents"), "Monthly price", { min: 0, max: 10_000_000 });
    const annual = int(form.get("price_annual_cents"), "Annual price", { min: 0, max: 100_000_000 });
    const leadLimit = int(form.get("lead_limit"), "Lead limit", { min: 0, max: 10_000_000 });
    const memberLimit = int(form.get("member_limit"), "Member limit", { min: 0, max: 10_000 });
    const aiLimit = int(form.get("ai_generation_limit"), "AI limit", { min: 0, max: 10_000_000 });
    const automationLimit = int(form.get("automation_limit"), "Automation limit", { min: 0, max: 100_000 });
    const documentLimit = int(form.get("document_limit"), "Document limit", { min: 0, max: 10_000_000 });
    const features = optionalStr(form.get("features"), 2000) || "{}";
    try {
      JSON.parse(features);
    } catch {
      throw new ValidationError("Features must be valid JSON.");
    }

    run(
      `update plans set name = ?, price_monthly_cents = ?, price_annual_cents = ?, lead_limit = ?, member_limit = ?,
        ai_generation_limit = ?, automation_limit = ?, document_limit = ?, features = ? where code = ?`,
      [name, monthly, annual, leadLimit, memberLimit, aiLimit, automationLimit, documentLimit, features, code]
    );
    audit({ actorId: admin.id, action: "admin.plan_updated", targetType: "plan", targetId: code });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/admin");
  revalidatePath("/pricing");
  return { notice: "Plan updated. New limits apply immediately." };
}

export async function suspendOrganizationAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  try {
    const admin = await requireSuperAdmin();
    const orgId = str(form.get("organization_id"), "Organisation", { min: 4 });
    const org = get<{ id: string; suspended_at: string | null; name: string }>(
      "select id, suspended_at, name from organizations where id = ?",
      [orgId]
    );
    if (!org) return { error: "Organisation not found." };
    const suspend = !org.suspended_at;
    run("update organizations set suspended_at = ?, updated_at = ? where id = ?", [suspend ? nowIso() : null, nowIso(), orgId]);
    audit({ organizationId: orgId, actorId: admin.id, action: suspend ? "admin.org_suspended" : "admin.org_restored" });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/admin");
  return { notice: "Organisation status updated." };
}

export async function setOrganizationPlanAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  try {
    const admin = await requireSuperAdmin();
    const orgId = str(form.get("organization_id"), "Organisation", { min: 4 });
    const planCode = str(form.get("plan_code"), "Plan", { min: 2, max: 40 });
    if (!get("select code from plans where code = ?", [planCode])) return { error: "Unknown plan code." };
    const existing = get("select id from subscriptions where organization_id = ?", [orgId]);
    if (existing) {
      run("update subscriptions set plan_code = ?, updated_at = ? where organization_id = ?", [planCode, nowIso(), orgId]);
    } else {
      run(
        "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, created_at, updated_at) values (?,?,?,?,?,?,?)",
        [crypto.randomUUID(), orgId, planCode, "active", "monthly", nowIso(), nowIso()]
      );
    }
    audit({ organizationId: orgId, actorId: admin.id, action: "admin.plan_assigned", metadata: { planCode } });
  } catch (e) {
    return handle(e);
  }
  revalidatePath("/admin");
  return { notice: "Plan assigned manually (no Stripe charge — use for support and QA)." };
}

/* ------------------------------------------------------------ email outbox */

/**
 * Retries specific outbox rows now.
 *
 * A human pressing "retry" outranks the backoff clock (`force`), because the
 * person knows the provider is back and the schedule does not.
 */
export async function retryOutboxEmailAction(form: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(form.get("outbox_id") ?? "");
  const ids = id ? [id] : undefined;
  const summary = await dispatchQueuedEmails({ ids, force: true, limit: 50 });
  audit({
    organizationId: null,
    actorId: admin.id,
    action: "email_outbox.retry",
    targetType: "email_outbox",
    targetId: id || "all",
    metadata: { ...summary },
  });
  logger.info("admin email retry", { adminId: admin.id, id: id || "all", summary });
  revalidatePath("/admin/email");
  redirect("/admin/email");
}

/** Retries everything that is queued or failed, ignoring the backoff schedule. */
export async function retryAllEmailsAction(_form: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const summary = await dispatchQueuedEmails({ force: true, limit: 100 });
  audit({
    organizationId: null,
    actorId: admin.id,
    action: "email_outbox.retry_all",
    targetType: "email_outbox",
    targetId: null,
    metadata: { ...summary },
  });
  revalidatePath("/admin/email");
  redirect(`/admin/email?retried=${summary.sent}`);
}

/**
 * Sends a real test email through the configured provider.
 *
 * This is the only honest way to prove email works in a deployment: the outbox
 * can look healthy while the provider rejects the domain, so the admin gets one
 * message and its exact provider response.
 */
export async function sendTestEmailAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  try {
    const admin = await requireSuperAdmin();
    const to = emailField(form.get("to")).toLowerCase();
    const result = await deliverEmail({
      to,
      subject: "BizPilot AI — test email",
      text: `This is a test email from your BizPilot AI deployment.

If you are reading this, Resend is configured correctly and outbound email works.

Sent from: ${emailFromAddress()}
At: ${nowIso()}`,
      kind: "test",
    });

    audit({
      organizationId: null,
      actorId: admin.id,
      action: "email_outbox.test_send",
      targetType: "email_outbox",
      targetId: result.outboxId,
      metadata: { to, ok: result.ok, code: result.ok ? "sent" : result.code },
    });

    if (result.ok) {
      return { notice: `Test email accepted by Resend (id ${result.id}) for ${to}. Check the inbox and the spam folder.` };
    }
    if (result.code === "not_configured") {
      return {
        error: `Email is not configured, so nothing was sent — the message is queued in the outbox (row ${result.outboxId.slice(0, 8)}). Add RESEND_API_KEY and press retry.`,
      };
    }
    return { error: `The provider rejected the message: ${result.message} (queued as ${result.outboxId.slice(0, 8)})` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not send the test email." };
  }
}

/** Deletes an outbox row (e.g. a typo'd address that will never be deliverable). */
export async function deleteOutboxEmailAction(form: FormData): Promise<void> {
  const admin = await requireSuperAdmin();
  const id = String(form.get("outbox_id") ?? "");
  if (id) {
    run("delete from email_outbox where id = ?", [id]);
    audit({
      organizationId: null,
      actorId: admin.id,
      action: "email_outbox.deleted",
      targetType: "email_outbox",
      targetId: id,
    });
  }
  revalidatePath("/admin/email");
  redirect("/admin/email");
}
