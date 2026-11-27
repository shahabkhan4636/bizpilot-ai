import { pkrPerUsd, toPkrRupees, validateLocalMethod, type BillingCycle, type LocalMethodKind } from "./local-payments";

/**
 * Platform billing rules — pure, no I/O.
 *
 * This is the money side of the *platform* (customers paying BizPilot), which is a
 * different question from the workspace side in `/billing/local` (a customer's own
 * clients paying that customer). Sharing one set of rules for both is how a product
 * ends up showing a customer their own wallet number on the subscription page, so
 * the two have separate tables, separate actions and separate validation — and this
 * module never reads a workspace's payout details.
 */

export const PLATFORM_SETTINGS_ID = "default";

export const FOUNDING_MEMBER_DEFAULTS = {
  /** Rs 1,500 in paisa. */
  priceCents: 150_000,
  slots: 10,
  /** Starter limits, but with 3 seats instead of 1 (decided in PHASE-0). */
  memberLimit: 3,
} as const;

export type PlatformSettings = {
  id: string;
  sadapay_number: string | null;
  jazzcash_number: string | null;
  easypaisa_number: string | null;
  bank_iban: string | null;
  bank_name: string | null;
  account_holder_name: string | null;
  default_method: LocalMethodKind;
  instructions: string | null;
  demo_mode: number;
  founding_member_price_cents: number;
  founding_member_slots: number;
  founding_member_member_limit: number;
  updated_at: string | null;
  updated_by: string | null;
};

export type PlatformSettingsInput = {
  sadapayNumber?: string | null;
  jazzcashNumber?: string | null;
  easypaisaNumber?: string | null;
  bankIban?: string | null;
  bankName?: string | null;
  accountHolderName?: string | null;
  defaultMethod: LocalMethodKind;
  instructions?: string | null;
  demoMode: boolean;
  foundingMemberPricePkr?: number | null;
  foundingMemberSlots?: number | null;
  foundingMemberMemberLimit?: number | null;
};

/** One configured payout destination, as the customer sees it. */
export type PlatformMethod = {
  kind: LocalMethodKind;
  label: string;
  number: string;
  accountTitle: string | null;
  bankName: string | null;
};

const METHOD_LABEL: Record<LocalMethodKind, string> = {
  sadapay: "SadaPay",
  jazzcash: "JazzCash",
  easypaisa: "EasyPaisa",
  bank: "Bank transfer (IBAN)",
  other: "Other",
};

export function methodLabel(kind: LocalMethodKind): string {
  return METHOD_LABEL[kind];
}

/**
 * The methods the platform actually accepts, in a stable order with the default
 * first. A method with no number is not offered — showing an empty JazzCash row
 * would invite a transfer nobody can receive.
 */
export function platformMethods(settings: PlatformSettings | null | undefined): PlatformMethod[] {
  if (!settings) return [];
  const rows: PlatformMethod[] = [];
  const push = (kind: LocalMethodKind, number: string | null, bankName: string | null = null) => {
    if (!number || number.trim().length === 0) return;
    rows.push({
      kind,
      label: METHOD_LABEL[kind],
      number: number.trim(),
      accountTitle: settings.account_holder_name,
      bankName,
    });
  };
  push("sadapay", settings.sadapay_number);
  push("jazzcash", settings.jazzcash_number);
  push("easypaisa", settings.easypaisa_number);
  push("bank", settings.bank_iban, settings.bank_name);

  const preferred = rows.findIndex((row) => row.kind === settings.default_method);
  if (preferred > 0) {
    const [first] = rows.splice(preferred, 1);
    rows.unshift(first!);
  }
  return rows;
}

export function isPlatformConfigured(settings: PlatformSettings | null | undefined): boolean {
  return platformMethods(settings).length > 0;
}

/**
 * Validates the owner's payout configuration.
 *
 * Refuses to save an unusable setup: at least one method, real wallet/IBAN formats
 * (reusing the same validators as the workspace screen), and a default that points
 * at something actually configured.
 */
export function validatePlatformSettings(input: PlatformSettingsInput): string | null {
  const holder = (input.accountHolderName ?? "").trim();
  if (holder.length < 3) return "Account holder name is required (at least 3 characters).";
  if (holder.length > 120) return "Account holder name must be under 120 characters.";

  const candidates: { kind: LocalMethodKind; number: string }[] = [
    { kind: "sadapay", number: (input.sadapayNumber ?? "").trim() },
    { kind: "jazzcash", number: (input.jazzcashNumber ?? "").trim() },
    { kind: "easypaisa", number: (input.easypaisaNumber ?? "").trim() },
    { kind: "bank", number: (input.bankIban ?? "").trim() },
  ];

  for (const candidate of candidates) {
    if (!candidate.number) continue;
    const problem = validateLocalMethod({
      kind: candidate.kind,
      accountTitle: holder,
      accountNumber: candidate.number,
      paymentLink: null,
    });
    if (problem) return problem;
  }

  const configured = candidates.filter((candidate) => candidate.number.length > 0);
  if (configured.length === 0) {
    return "Add at least one payout method (SadaPay, JazzCash, EasyPaisa or bank IBAN) — otherwise a customer has nowhere to send money.";
  }
  if (!configured.some((candidate) => candidate.kind === input.defaultMethod)) {
    return `The default method (${METHOD_LABEL[input.defaultMethod]}) has no number configured. Fill it in or choose another default.`;
  }

  if ((input.bankIban ?? "").trim() && !(input.bankName ?? "").trim()) {
    return "Bank name is required when an IBAN is configured.";
  }

  if (input.foundingMemberPricePkr !== null && input.foundingMemberPricePkr !== undefined) {
    if (!Number.isFinite(input.foundingMemberPricePkr) || input.foundingMemberPricePkr <= 0) {
      return "Founding Member price must be greater than zero.";
    }
    if (input.foundingMemberPricePkr > 10_000_000) return "Founding Member price is too large.";
  }
  if (input.foundingMemberSlots !== null && input.foundingMemberSlots !== undefined) {
    if (!Number.isInteger(input.foundingMemberSlots) || input.foundingMemberSlots < 0 || input.foundingMemberSlots > 1000) {
      return "Founding Member slots must be a whole number between 0 and 1000.";
    }
  }
  if (input.foundingMemberMemberLimit !== null && input.foundingMemberMemberLimit !== undefined) {
    if (!Number.isInteger(input.foundingMemberMemberLimit) || input.foundingMemberMemberLimit < 1 || input.foundingMemberMemberLimit > 100) {
      return "Founding Member seats must be a whole number between 1 and 100.";
    }
  }

  return null;
}

/** How many Founding Member places are left (never negative). */
export function foundingSlotsLeft(settings: Pick<PlatformSettings, "founding_member_slots">, grantedCount: number): number {
  return Math.max(0, settings.founding_member_slots - grantedCount);
}

/**
 * True when this workspace could still take a Founding Member place.
 *
 * Deliberately takes `alreadyMember` so a second claim from an existing Founding
 * Member does not consume a second slot.
 */
export function isFoundingEligible(input: {
  grantedCount: number;
  slots: number;
  alreadyMember: boolean;
}): boolean {
  if (input.alreadyMember) return false;
  return input.grantedCount < input.slots;
}

export type ClaimAmountInput = {
  planMonthlyCents: number;
  planAnnualCents: number;
  cycle: BillingCycle;
  founding: { priceCents: number } | null;
  /** PKR per USD; defaults to the configured rate. */
  rate?: number;
};

/**
 * What the customer is asked to send, in paisa.
 *
 * Founding Members are quoted their locked price, not the catalogue price — that is
 * the entire promise of the offer. Everyone else is quoted the rupee conversion of
 * the USD catalogue, rounded up to the next Rs 100 by `toPkrRupees`.
 */
export function resolveClaimAmountCents(input: ClaimAmountInput): number {
  if (input.founding) {
    const locked = input.founding.priceCents;
    return input.cycle === "annual" ? locked * 12 : locked;
  }
  const usdCents = input.cycle === "annual" ? input.planAnnualCents : input.planMonthlyCents;
  // `toPkrRupees` returns rupees; claims are stored in paisa everywhere else.
  return toPkrRupees(usdCents, input.rate ?? pkrPerUsd()) * 100;
}

/** Human-readable rupees for the claim form. */
export function rupees(cents: number): number {
  return Math.round(cents / 100);
}
