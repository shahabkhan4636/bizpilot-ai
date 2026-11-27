import { all, get, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { audit, logActivity } from "@/lib/audit";
import { notify } from "@/lib/notifications";
import { periodEndFrom, type BillingCycle, type LocalMethodKind } from "@/lib/local-payments";
import { ensureSubscriptionPlan } from "@/lib/payments/approve";
import {
  FOUNDING_MEMBER_DEFAULTS,
  PLATFORM_SETTINGS_ID,
  isFoundingEligible,
  resolveClaimAmountCents,
  type PlatformSettings,
} from "@/lib/platform-payments";

/**
 * Server side of platform billing (customers paying BizPilot).
 *
 * Kept apart from `src/lib/actions/platform-payments.ts` (which only does auth,
 * revalidation and redirects) so the rules can be tested without a browser session —
 * money logic must be testable directly, not only through a form.
 */

/* ------------------------------------------------------------------ settings */

const EMPTY_SETTINGS: PlatformSettings = {
  id: PLATFORM_SETTINGS_ID,
  sadapay_number: null,
  jazzcash_number: null,
  easypaisa_number: null,
  bank_iban: null,
  bank_name: null,
  account_holder_name: null,
  default_method: "sadapay",
  instructions: null,
  demo_mode: 0,
  founding_member_price_cents: FOUNDING_MEMBER_DEFAULTS.priceCents,
  founding_member_slots: FOUNDING_MEMBER_DEFAULTS.slots,
  founding_member_member_limit: FOUNDING_MEMBER_DEFAULTS.memberLimit,
  updated_at: null,
  updated_by: null,
};

/**
 * The single platform row, or defaults when nobody has configured it yet.
 *
 * Never auto-inserts on read: a page render must not create configuration, and
 * "unconfigured" has to look different from "configured with empty fields".
 */
export function getPlatformSettings(): PlatformSettings {
  const row = get<PlatformSettings>("select * from platform_settings where id = ?", [PLATFORM_SETTINGS_ID]);
  return row ?? EMPTY_SETTINGS;
}

export type SaveSettingsInput = {
  sadapayNumber: string | null;
  jazzcashNumber: string | null;
  easypaisaNumber: string | null;
  bankIban: string | null;
  bankName: string | null;
  accountHolderName: string | null;
  defaultMethod: LocalMethodKind;
  instructions: string | null;
  demoMode: boolean;
  foundingMemberPriceCents: number;
  foundingMemberSlots: number;
  foundingMemberMemberLimit: number;
  actorId: string | null;
};

export function savePlatformSettings(input: SaveSettingsInput): void {
  const now = nowIso();
  const existing = get<{ id: string }>("select id from platform_settings where id = ?", [PLATFORM_SETTINGS_ID]);
  if (existing) {
    run(
      `update platform_settings
          set sadapay_number = ?, jazzcash_number = ?, easypaisa_number = ?, bank_iban = ?, bank_name = ?,
              account_holder_name = ?, default_method = ?, instructions = ?, demo_mode = ?,
              founding_member_price_cents = ?, founding_member_slots = ?, founding_member_member_limit = ?,
              updated_at = ?, updated_by = ?
        where id = ?`,
      [
        input.sadapayNumber,
        input.jazzcashNumber,
        input.easypaisaNumber,
        input.bankIban,
        input.bankName,
        input.accountHolderName,
        input.defaultMethod,
        input.instructions,
        input.demoMode ? 1 : 0,
        input.foundingMemberPriceCents,
        input.foundingMemberSlots,
        input.foundingMemberMemberLimit,
        now,
        input.actorId,
        PLATFORM_SETTINGS_ID,
      ]
    );
  } else {
    run(
      `insert into platform_settings
         (id, sadapay_number, jazzcash_number, easypaisa_number, bank_iban, bank_name, account_holder_name,
          default_method, instructions, demo_mode, founding_member_price_cents, founding_member_slots,
          founding_member_member_limit, updated_at, updated_by)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        PLATFORM_SETTINGS_ID,
        input.sadapayNumber,
        input.jazzcashNumber,
        input.easypaisaNumber,
        input.bankIban,
        input.bankName,
        input.accountHolderName,
        input.defaultMethod,
        input.instructions,
        input.demoMode ? 1 : 0,
        input.foundingMemberPriceCents,
        input.foundingMemberSlots,
        input.foundingMemberMemberLimit,
        now,
        input.actorId,
      ]
    );
  }

  audit({
    organizationId: null,
    actorId: input.actorId,
    action: "platform_settings.updated",
    targetType: "platform_settings",
    targetId: PLATFORM_SETTINGS_ID,
    // Numbers are not secrets, but they are personal: log which kinds changed only.
    metadata: {
      methods: [
        input.sadapayNumber ? "sadapay" : null,
        input.jazzcashNumber ? "jazzcash" : null,
        input.easypaisaNumber ? "easypaisa" : null,
        input.bankIban ? "bank" : null,
      ].filter(Boolean),
      defaultMethod: input.defaultMethod,
      demoMode: input.demoMode,
    },
  });
}

/* ------------------------------------------------------------ founding members */

export function foundingGrantedCount(): number {
  const row = get<{ c: number }>("select count(*) as c from founding_memberships");
  return Number(row?.c ?? 0);
}

export function foundingForOrg(organizationId: string): { locked_price_cents: number; member_limit: number; source: string } | null {
  const row = get<{ locked_price_cents: number; member_limit: number; source: string }>(
    "select locked_price_cents, member_limit, source from founding_memberships where organization_id = ?",
    [organizationId]
  );
  return row ?? null;
}

export function grantFoundingMembership(input: {
  organizationId: string;
  actorId: string | null;
  source?: "auto" | "manual";
  note?: string | null;
  priceCents?: number;
  memberLimit?: number;
}): { ok: true; created: boolean } {
  const existing = foundingForOrg(input.organizationId);
  const settings = getPlatformSettings();
  if (existing) {
    // Price already locked: re-granting must not silently raise someone's price.
    return { ok: true, created: false };
  }
  run(
    `insert into founding_memberships (id, organization_id, locked_price_cents, member_limit, source, note, granted_by, granted_at)
     values (?,?,?,?,?,?,?,?)`,
    [
      newId(),
      input.organizationId,
      input.priceCents ?? settings.founding_member_price_cents,
      input.memberLimit ?? settings.founding_member_member_limit,
      input.source ?? "manual",
      input.note ?? null,
      input.actorId,
      nowIso(),
    ]
  );
  audit({
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "founding_member.granted",
    targetType: "organization",
    targetId: input.organizationId,
    metadata: { source: input.source ?? "manual", priceCents: input.priceCents ?? settings.founding_member_price_cents },
  });
  notify({
    organizationId: input.organizationId,
    type: "system",
    level: "success",
    title: "Founding Member price locked",
    body: `Your price is locked at Rs ${Math.round((input.priceCents ?? settings.founding_member_price_cents) / 100).toLocaleString()}/month for as long as you stay subscribed.`,
    href: "/billing",
  });
  return { ok: true, created: true };
}

export function revokeFoundingMembership(input: { organizationId: string; actorId: string | null }): boolean {
  const existing = foundingForOrg(input.organizationId);
  if (!existing) return false;
  run("delete from founding_memberships where organization_id = ?", [input.organizationId]);
  audit({
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: "founding_member.revoked",
    targetType: "organization",
    targetId: input.organizationId,
    metadata: { lockedPriceCents: existing.locked_price_cents },
  });
  return true;
}

/* -------------------------------------------------------------------- quotes */

export type ClaimQuote = {
  amountCents: number;
  amountPkr: number;
  founding: boolean;
  slotsLeft: number;
};

/**
 * What this workspace would be asked to send right now.
 *
 * A Founding Member is always quoted the locked price; everyone else the rupee
 * conversion of the catalogue, unless a Founding Member place is still open — in
 * which case the cheaper offer is shown and the claim records that choice.
 */
export function quoteForClaim(organizationId: string, planCode: string, cycle: BillingCycle): ClaimQuote | null {
  const plan = get<{ price_monthly_cents: number; price_annual_cents: number }>(
    "select price_monthly_cents, price_annual_cents from plans where code = ? and is_active = 1",
    [planCode]
  );
  if (!plan) return null;

  const settings = getPlatformSettings();
  const member = foundingForOrg(organizationId);
  const grantedCount = foundingGrantedCount();
  const slotsLeft = Math.max(0, settings.founding_member_slots - grantedCount);
  const eligible = !member && isFoundingEligible({ grantedCount, slots: settings.founding_member_slots, alreadyMember: Boolean(member) });

  const amountCents = resolveClaimAmountCents({
    planMonthlyCents: plan.price_monthly_cents,
    planAnnualCents: plan.price_annual_cents,
    cycle,
    founding: member
      ? { priceCents: member.locked_price_cents }
      : eligible
        ? { priceCents: settings.founding_member_price_cents }
        : null,
  });

  return {
    amountCents,
    amountPkr: Math.round(amountCents / 100),
    founding: Boolean(member) || eligible,
    slotsLeft,
  };
}

/* -------------------------------------------------------------------- claims */

export type ClaimRow = {
  id: string;
  organization_id: string;
  organization_name?: string;
  plan_code: string;
  billing_cycle: BillingCycle;
  amount_cents: number;
  currency: string;
  method_kind: LocalMethodKind;
  reference: string;
  payer_note: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  submitted_by: string | null;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  self_approved: number;
  founding_member: number;
};

export function openClaimForOrg(organizationId: string): ClaimRow | undefined {
  return get<ClaimRow>(
    "select * from platform_payment_claims where organization_id = ? and status = 'pending' order by submitted_at desc limit 1",
    [organizationId]
  );
}

export function listClaimsForOrg(organizationId: string, limit = 20): ClaimRow[] {
  return all<ClaimRow>(
    "select * from platform_payment_claims where organization_id = ? order by submitted_at desc limit ?",
    [organizationId, limit]
  );
}

export function listAllClaims(status?: ClaimRow["status"], limit = 100): ClaimRow[] {
  if (status) {
    return all<ClaimRow>(
      `select c.*, o.name as organization_name from platform_payment_claims c
         join organizations o on o.id = c.organization_id
        where c.status = ? order by c.submitted_at desc limit ?`,
      [status, limit]
    );
  }
  return all<ClaimRow>(
    `select c.*, o.name as organization_name from platform_payment_claims c
       join organizations o on o.id = c.organization_id
      order by c.submitted_at desc limit ?`,
    [limit]
  );
}

export type SubmitClaimInput = {
  organizationId: string;
  planCode: string;
  cycle: BillingCycle;
  methodKind: LocalMethodKind;
  reference: string;
  note: string | null;
  userId: string | null;
  /** Demo mode auto-approves the platform owner's own claim (owner testing only). */
  isPlatformOwnerWorkspace?: boolean;
};

export type SubmitClaimResult =
  | { ok: true; claimId: string; amountCents: number; founding: boolean; autoApproved: boolean }
  | { ok: false; message: string };

export function submitPlatformClaim(input: SubmitClaimInput): SubmitClaimResult {
  const settings = getPlatformSettings();
  const quote = quoteForClaim(input.organizationId, input.planCode, input.cycle);
  if (!quote) return { ok: false, message: "That plan is not available." };

  // The amount is computed here, never taken from the form: a customer cannot
  // decide what a plan costs by editing a hidden input.
  const open = openClaimForOrg(input.organizationId);
  if (open) {
    return { ok: false, message: "You already have a payment waiting for approval. It will be reviewed before you submit another." };
  }

  const id = newId();
  const now = nowIso();
  run(
    `insert into platform_payment_claims
       (id, organization_id, plan_code, billing_cycle, amount_cents, currency, method_kind, reference, payer_note,
        status, submitted_by, submitted_at, founding_member)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id,
      input.organizationId,
      input.planCode,
      input.cycle,
      quote.amountCents,
      "PKR",
      input.methodKind,
      input.reference,
      input.note,
      "pending",
      input.userId,
      now,
      quote.founding ? 1 : 0,
    ]
  );

  audit({
    organizationId: input.organizationId,
    actorId: input.userId,
    action: "platform_payment.submitted",
    targetType: "platform_payment_claim",
    targetId: id,
    metadata: { planCode: input.planCode, cycle: input.cycle, amountCents: quote.amountCents, founding: quote.founding },
  });
  logActivity({
    organizationId: input.organizationId,
    actorId: input.userId,
    entityType: "organization",
    entityId: input.organizationId,
    action: "platform_payment.submitted",
    summary: `Platform payment submitted (${input.reference}) for the ${input.planCode} plan`,
  });
  notify({
    organizationId: input.organizationId,
    type: "system",
    level: "info",
    title: "Platform payment submitted",
    body: `${input.reference} · Rs ${quote.amountPkr.toLocaleString()} — waiting for the platform owner to approve it.`,
    href: "/billing",
  });

  // Demo mode: the platform owner testing their own purchase should not have to
  // approve themselves twice. Only ever applies to the owner's own workspace.
  if (settings.demo_mode === 1 && input.isPlatformOwnerWorkspace) {
    const outcome = reviewPlatformClaim({ claimId: id, decision: "approve", actorId: input.userId, note: "demo_mode auto-approval" });
    return { ok: true, claimId: id, amountCents: quote.amountCents, founding: quote.founding, autoApproved: outcome.ok };
  }

  return { ok: true, claimId: id, amountCents: quote.amountCents, founding: quote.founding, autoApproved: false };
}

export type ReviewOutcome =
  | { ok: true; planCode: string; periodEnd: string; selfApproved: boolean; foundingGranted: boolean }
  | { ok: false; message: string };

/**
 * Approving or rejecting a platform claim.
 *
 * Approval is where a subscription changes hands, so it is the strictest function
 * here: only a `pending` claim moves, the plan activation is shared with the manual
 * local-payment path, and a self-approval (the claimant is also the approver) is
 * recorded rather than silently allowed.
 */
export function reviewPlatformClaim(input: {
  claimId: string;
  decision: "approve" | "reject";
  actorId: string | null;
  note?: string | null;
}): ReviewOutcome {
  const claim = get<ClaimRow & { submitted_by_email?: string | null }>(
    `select c.*, p.email as submitted_by_email
       from platform_payment_claims c
       left join profiles p on p.id = c.submitted_by
      where c.id = ?`,
    [input.claimId]
  );
  if (!claim) return { ok: false, message: "That claim does not exist." };
  if (claim.status !== "pending") return { ok: false, message: `That claim is already ${claim.status}.` };

  const now = nowIso();

  if (input.decision === "reject") {
    run(
      `update platform_payment_claims set status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ?
        where id = ? and status = 'pending'`,
      [input.actorId, now, input.note ?? null, input.claimId]
    );
    audit({
      organizationId: claim.organization_id,
      actorId: input.actorId,
      action: "platform_payment.rejected",
      targetType: "platform_payment_claim",
      targetId: input.claimId,
      metadata: { reviewNote: input.note ?? null },
    });
    notify({
      organizationId: claim.organization_id,
      type: "system",
      level: "warning",
      title: "Platform payment not approved",
      body: input.note ?? "The payment could not be verified. Submit a new claim with the correct transaction ID.",
      href: "/billing",
    });
    return { ok: false, message: "Claim rejected." };
  }

  // Self-approval: allowed (a one-person business must be able to run its own
  // product) but recorded, so the audit trail never pretends it was independent.
  let selfApproved = false;
  if (input.actorId) {
    const actor = get<{ id: string; email: string }>("select id, email from profiles where id = ?", [input.actorId]);
    const claimantEmail = (claim.submitted_by_email ?? "").toLowerCase();
    selfApproved = Boolean(actor && claimantEmail && actor.email.toLowerCase() === claimantEmail);
  }

  const changed = run(
    `update platform_payment_claims
        set status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = ?, self_approved = ?
      where id = ? and status = 'pending'`,
    [input.actorId, now, input.note ?? null, selfApproved ? 1 : 0, input.claimId]
  );
  if (changed.changes === 0) return { ok: false, message: "That claim was already reviewed." };

  const periodEnd = ensureSubscriptionPlan({
    organizationId: claim.organization_id,
    planCode: claim.plan_code,
    billingCycle: claim.billing_cycle,
    now,
  });

  // Founding Member: granted at approval, while places remain. The claim already
  // recorded whether the customer was quoted the founding price.
  let foundingGranted = false;
  const settings = getPlatformSettings();
  const already = foundingForOrg(claim.organization_id);
  if (!already) {
    const granted = foundingGrantedCount();
    const eligible =
      claim.founding_member === 1 ||
      isFoundingEligible({ grantedCount: granted, slots: settings.founding_member_slots, alreadyMember: false });
    if (eligible && granted < settings.founding_member_slots) {
      const result = grantFoundingMembership({
        organizationId: claim.organization_id,
        actorId: input.actorId,
        source: "auto",
        note: `Granted with claim ${input.claimId.slice(0, 8)}`,
      });
      foundingGranted = result.created;
    }
  }

  audit({
    organizationId: claim.organization_id,
    actorId: input.actorId,
    action: "platform_payment.approved",
    targetType: "platform_payment_claim",
    targetId: input.claimId,
    metadata: {
      planCode: claim.plan_code,
      cycle: claim.billing_cycle,
      amountCents: claim.amount_cents,
      reference: claim.reference,
      selfApproved,
      foundingGranted,
    },
  });
  logActivity({
    organizationId: claim.organization_id,
    actorId: input.actorId,
    entityType: "organization",
    entityId: claim.organization_id,
    action: "platform_payment.approved",
    summary: `Platform payment approved — ${claim.plan_code} (${claim.billing_cycle}) active until ${periodEnd.slice(0, 10)}${selfApproved ? " (self-approved)" : ""}`,
  });
  notify({
    organizationId: claim.organization_id,
    type: "system",
    level: "success",
    title: `Plan activated: ${claim.plan_code}`,
    body: `Your payment was approved. The plan runs until ${periodEnd.slice(0, 10)}.`,
    href: "/billing",
  });

  return { ok: true, planCode: claim.plan_code, periodEnd, selfApproved, foundingGranted };
}

/** Used by the /billing page and the admin queue to show a claim's own plan name. */
export function planNameFor(planCode: string): string {
  return get<{ name: string }>("select name from plans where code = ?", [planCode])?.name ?? planCode;
}

/** Small helper kept for symmetry with the local-payment module and for tests. */
export function claimExists(requestId: string): boolean {
  return Boolean(get<{ id: string }>("select id from platform_payment_claims where id = ?", [requestId]));
}

export { periodEndFrom };
