/**
 * Local (Pakistan) payment helpers — pure functions, no I/O, so the rules can be
 * tested without a database or a browser.
 *
 * Why this exists: Stripe does not onboard Pakistani businesses, and the merchant
 * APIs for SadaPay/JazzCash/EasyPaisa require an approved merchant account. The
 * workflow that works on day one is *receive a transfer, reconcile it by hand*,
 * so the product models exactly that and never pretends a gateway confirmed it.
 */

export const LOCAL_METHOD_KINDS = ["sadapay", "jazzcash", "easypaisa", "bank", "other"] as const;
export type LocalMethodKind = (typeof LOCAL_METHOD_KINDS)[number];

export const LOCAL_METHOD_LABEL: Record<LocalMethodKind, string> = {
  sadapay: "SadaPay",
  jazzcash: "JazzCash",
  easypaisa: "EasyPaisa",
  bank: "Bank transfer (IBAN)",
  other: "Other",
};

/** Placeholders shown in the setup form, per wallet — real providers, real formats. */
export const LOCAL_METHOD_HINT: Record<LocalMethodKind, { accountTitle: string; accountNumber: string }> = {
  sadapay: { accountTitle: "Your name as registered on SadaPay", accountNumber: "03001234567" },
  jazzcash: { accountTitle: "Account holder name", accountNumber: "03001234567" },
  easypaisa: { accountTitle: "Account holder name", accountNumber: "03451234567" },
  bank: { accountTitle: "Account title", accountNumber: "PK36SCBL0000001123456702" },
  other: { accountTitle: "Account title", accountNumber: "Account / wallet number" },
};

/**
 * Per-plan price in PKR, converted from the USD catalogue.
 *
 * The catalogue is priced in USD cents; a Pakistani customer is quoted rupees. The
 * rate is configuration (`PKR_PER_USD`), not a hardcoded number, because a stale
 * hardcoded rate is how a business quietly loses money on every sale.
 */
export function pkrPerUsd(): number {
  const raw = Number((process.env.PKR_PER_USD ?? "").trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 280;
}

/** USD cents → PKR rupees, rounded up to the nearest 100 so the amount is payable. */
export function toPkrRupees(usdCents: number, rate = pkrPerUsd()): number {
  if (!Number.isFinite(usdCents) || usdCents <= 0) return 0;
  const rupees = (usdCents / 100) * rate;
  return Math.ceil(rupees / 100) * 100;
}

export type MethodInput = {
  kind: LocalMethodKind;
  accountTitle: string;
  accountNumber: string;
  label?: string | null;
  paymentLink?: string | null;
  instructions?: string | null;
};

/**
 * Validates a payout account. Returns an error message, or null when it is usable.
 *
 * Getting this wrong means a customer sends money to a number that cannot receive
 * it, which is worse than refusing the setup: the money is gone and the customer is
 * angry. So the formats are checked here rather than trusted from the form.
 */
export function validateLocalMethod(input: MethodInput): string | null {
  const title = input.accountTitle.trim();
  if (title.length < 3) return "Account title must be at least 3 characters.";
  if (title.length > 120) return "Account title must be under 120 characters.";

  const number = input.accountNumber.replace(/[\s-]/g, "");
  if (!number) return "Account number is required.";

  if (input.kind === "jazzcash" || input.kind === "easypaisa" || input.kind === "sadapay") {
    // Pakistani mobile wallets are 11 digits starting 03 (or +923…).
    const normalised = number.replace(/^\+?92/, "0");
    if (!/^03\d{9}$/.test(normalised)) {
      return `${LOCAL_METHOD_LABEL[input.kind]} numbers are 11 digits and start with 03 (e.g. 03001234567).`;
    }
    return null;
  }

  if (input.kind === "bank") {
    // Pakistani IBAN: PK + 2 check digits + 4-letter bank code + 16 alphanumerics = 24.
    if (/^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/i.test(number)) return null;
    if (/^\d{8,20}$/.test(number)) return null; // legacy account number
    return "Enter a Pakistani IBAN (PK36SCBL0000001123456702) or an 8–20 digit account number.";
  }

  if (number.length < 4) return "Account number looks too short.";
  return null;
}

/** A payment link must be http(s) — never a javascript: URL pasted into an anchor. */
export function validatePaymentLink(link: string | null | undefined): string | null {
  const value = (link ?? "").trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Payment link must be a full URL, for example https://sadapay.pk/…";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "Payment link must start with https://";
  }
  return null;
}

/** Masks a wallet number/IBAN for display: the customer sees the full number, logs do not. */
export function maskAccountNumber(value: string): string {
  const compact = value.replace(/\s/g, "");
  if (compact.length <= 4) return "••••";
  return `${"•".repeat(Math.max(0, compact.length - 4))}${compact.slice(-4)}`;
}

export const BILLING_CYCLES = ["monthly", "annual"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/** Period end after an approval: one month or one year from the approval time. */
export function periodEndFrom(cycle: BillingCycle, from = new Date()): string {
  const end = new Date(from.getTime());
  if (cycle === "annual") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end.toISOString();
}

/**
 * FNV-1a, 32-bit, base-36 — a *disambiguator*, not a security control.
 *
 * Deliberately not `node:crypto`: this module is imported by client components, and
 * a crypto import there would drag a server module into the browser bundle.
 */
function shortDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(4, "0").slice(0, 4);
}

/**
 * What the customer is told to put in their transfer note, so reconciliation is
 * possible.
 *
 * The slug is truncated *and* a digest of the full slug is appended, because two
 * workspaces can share their first characters ("ali-store-1" / "ali-store-2").
 * Truncating alone made two different customers' transfer notes identical — which
 * in this workflow means money being matched to the wrong workspace. Uniqueness of
 * the note matters more than it being pretty.
 */
export function paymentReference(workspaceSlug: string): string {
  const base = workspaceSlug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "WORKSPACE";
  return `BP-${base}-${shortDigest(workspaceSlug)}`;
}

/**
 * Refund rules, kept pure so both the action and the tests use exactly one
 * definition of "is this refund allowed".
 *
 * A refund can never exceed what was actually paid minus what has already gone
 * back, because approving a refund twice is how a business pays a customer twice.
 */
export function validateRefund(input: { paidCents: number; alreadyRefundedCents: number; amountCents: number }): string | null {
  if (!Number.isFinite(input.amountCents) || input.amountCents <= 0) {
    return "Refund amount must be greater than zero.";
  }
  const remaining = input.paidCents - input.alreadyRefundedCents;
  if (remaining <= 0) return "That payment has already been fully refunded.";
  if (input.amountCents > remaining) {
    return `Only Rs ${(remaining / 100).toLocaleString()} is left to refund on that payment.`;
  }
  return null;
}

/** True when nothing is left to refund — the point where access must stop. */
export function isFullyRefunded(paidCents: number, refundedCents: number): boolean {
  return paidCents > 0 && refundedCents >= paidCents;
}
