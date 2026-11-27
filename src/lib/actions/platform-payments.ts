"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAuth, requireSuperAdmin } from "@/lib/auth";
import { requirePermission, forbiddenRedirect } from "@/lib/authz";
import { ValidationError, oneOf, optionalStr, str } from "@/lib/validate";
import { LOCAL_METHOD_KINDS, type BillingCycle, type LocalMethodKind } from "@/lib/local-payments";
import { validatePlatformSettings } from "@/lib/platform-payments";
import {
  getPlatformSettings,
  grantFoundingMembership,
  revokeFoundingMembership,
  reviewPlatformClaim,
  savePlatformSettings,
  submitPlatformClaim,
} from "@/lib/platform-payments-server";

export type PlatformPaymentState = { error?: string; notice?: string } | null;

function fail(e: unknown): PlatformPaymentState {
  if (e instanceof ValidationError) return { error: e.message };
  if (e instanceof Error && e.message === "NEXT_REDIRECT") throw e;
  if (e instanceof Error) return { error: e.message };
  return { error: "Something went wrong. Nothing was saved." };
}

function pkrToCents(value: FormDataEntryValue | null, field: string, fallback: number): number {
  const raw = String(value ?? "").trim().replace(/,/g, "");
  if (raw.length === 0) return fallback;
  const rupees = Number(raw);
  if (!Number.isFinite(rupees) || rupees <= 0) throw new ValidationError(`${field} must be a positive number of rupees.`);
  return Math.round(rupees * 100);
}

/* ----------------------------------------------------------------- settings */

/**
 * Platform owner saves where customers should send money.
 *
 * Super-admin only, and the numbers live in the database — never in source — so a
 * wallet change is a form submission rather than a deploy.
 */
export async function savePlatformSettingsAction(
  _prev: PlatformPaymentState,
  form: FormData
): Promise<PlatformPaymentState> {
  try {
    const admin = await requireSuperAdmin();
    const current = getPlatformSettings();

    const accountHolderName = str(form.get("account_holder_name"), "Account holder name", { min: 3, max: 120 });
    const sadapayNumber = optionalStr(form.get("sadapay_number"), 40) || null;
    const jazzcashNumber = optionalStr(form.get("jazzcash_number"), 40) || null;
    const easypaisaNumber = optionalStr(form.get("easypaisa_number"), 40) || null;
    const bankIban = optionalStr(form.get("bank_iban"), 60) || null;
    const bankName = optionalStr(form.get("bank_name"), 80) || null;
    const defaultMethod = oneOf<LocalMethodKind>(form.get("default_method"), "Default method", LOCAL_METHOD_KINDS, "sadapay");
    const instructions = optionalStr(form.get("instructions"), 1000) || null;
    const demoMode = String(form.get("demo_mode") ?? "") === "on";
    const priceCents = pkrToCents(form.get("founding_member_price"), "Founding Member price", current.founding_member_price_cents);
    const slots = Number(String(form.get("founding_member_slots") ?? "").trim() || current.founding_member_slots);
    const memberLimit = Number(String(form.get("founding_member_member_limit") ?? "").trim() || current.founding_member_member_limit);

    const problem = validatePlatformSettings({
      sadapayNumber,
      jazzcashNumber,
      easypaisaNumber,
      bankIban,
      bankName,
      accountHolderName,
      defaultMethod,
      instructions,
      demoMode,
      foundingMemberPricePkr: Math.round(priceCents / 100),
      foundingMemberSlots: slots,
      foundingMemberMemberLimit: memberLimit,
    });
    if (problem) return { error: problem };

    savePlatformSettings({
      sadapayNumber,
      jazzcashNumber,
      easypaisaNumber,
      bankIban,
      bankName,
      accountHolderName,
      defaultMethod,
      instructions,
      demoMode,
      foundingMemberPriceCents: priceCents,
      foundingMemberSlots: slots,
      foundingMemberMemberLimit: memberLimit,
      actorId: admin.id,
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/admin/platform-payments");
  revalidatePath("/billing/platform");
  revalidatePath("/pricing");
  return { notice: "Payout settings saved. Customers see these numbers on the payment page." };
}

/* ------------------------------------------------------------------- claims */

/** A workspace admin submits proof that they paid the platform. */
export async function submitPlatformClaimAction(
  _prev: PlatformPaymentState,
  form: FormData
): Promise<PlatformPaymentState> {
  let claimId = "";
  try {
    const { user, membership } = await requireAuth().catch(() => forbiddenRedirect("billing:manage"));
    await requirePermission("billing:manage");

    const planCode = str(form.get("plan_code"), "Plan", { min: 2, max: 40 });
    const cycle = oneOf<BillingCycle>(form.get("billing_cycle"), "Billing cycle", ["monthly", "annual"] as const, "monthly");
    const methodKind = oneOf<LocalMethodKind>(form.get("method_kind"), "Payment method", LOCAL_METHOD_KINDS);
    const reference = str(form.get("reference"), "Transaction ID", { min: 3, max: 80 });
    const note = optionalStr(form.get("note"), 500) || null;

    // The platform owner's own workspace is the only place demo_mode can auto-approve.
    const { isSuperAdmin } = await import("@/lib/owner");
    const isPlatformOwnerWorkspace = isSuperAdmin({ email: user.email });

    const result = submitPlatformClaim({
      organizationId: membership.organization_id,
      planCode,
      cycle,
      methodKind,
      reference,
      note,
      userId: user.id,
      isPlatformOwnerWorkspace,
    });
    if (!result.ok) return { error: result.message };
    claimId = result.claimId;
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/billing");
  revalidatePath("/billing/platform");
  revalidatePath("/admin/platform-payments");
  redirect(`/billing?claim=${claimId.slice(0, 8)}`);
}

async function review(form: FormData, decision: "approve" | "reject"): Promise<PlatformPaymentState> {
  let notice = "";
  try {
    const admin = await requireSuperAdmin();
    const claimId = str(form.get("claim_id"), "Claim", { min: 8, max: 60 });
    const note = optionalStr(form.get("review_note"), 500) || null;
    const result = reviewPlatformClaim({ claimId, decision, actorId: admin.id, note });
    if (!result.ok) return { error: result.message };
    notice =
      decision === "approve"
        ? `Approved — ${result.planCode} active until ${result.periodEnd.slice(0, 10)}${result.selfApproved ? " (self-approved, recorded)" : ""}${result.foundingGranted ? " · Founding Member price locked" : ""}`
        : "Claim rejected.";
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/admin/platform-payments");
  revalidatePath("/billing");
  revalidatePath("/billing/platform");
  // `revalidatePath` re-renders the page, which drops the form's local state — so the
  // confirmation goes in the URL instead. A reviewer must always see that the click
  // landed, not just a row quietly disappearing from the queue.
  redirect(`/admin/platform-payments?reviewed=${decision}`);
  return { notice };
}

export async function approvePlatformClaimAction(
  _prev: PlatformPaymentState,
  form: FormData
): Promise<PlatformPaymentState> {
  return review(form, "approve");
}

export async function rejectPlatformClaimAction(
  _prev: PlatformPaymentState,
  form: FormData
): Promise<PlatformPaymentState> {
  return review(form, "reject");
}

/* ---------------------------------------------------------- founding members */

/** Manual grant from /admin/workspaces/[id] — for a customer paid outside the flow. */
export async function grantFoundingMemberAction(
  _prev: PlatformPaymentState,
  form: FormData
): Promise<PlatformPaymentState> {
  let organizationId = "";
  try {
    const admin = await requireSuperAdmin();
    organizationId = str(form.get("organization_id"), "Workspace", { min: 8, max: 60 });
    const note = optionalStr(form.get("note"), 500) || null;
    const result = grantFoundingMembership({ organizationId, actorId: admin.id, source: "manual", note });
    revalidatePath("/admin/platform-payments");
    revalidatePath("/admin/workspaces");
    revalidatePath("/billing");
    return { notice: result.created ? "Founding Member price locked for this workspace." : "This workspace is already a Founding Member." };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeFoundingMemberAction(
  _prev: PlatformPaymentState,
  form: FormData
): Promise<PlatformPaymentState> {
  try {
    const admin = await requireSuperAdmin();
    const organizationId = str(form.get("organization_id"), "Workspace", { min: 8, max: 60 });
    const removed = revokeFoundingMembership({ organizationId, actorId: admin.id });
    revalidatePath("/admin/platform-payments");
    revalidatePath("/admin/workspaces");
    revalidatePath("/billing");
    return removed
      ? { notice: "Founding Member status removed. This is audited and cannot be undone for the customer — re-granting locks today's price." }
      : { error: "That workspace is not a Founding Member." };
  } catch (e) {
    return fail(e);
  }
}
