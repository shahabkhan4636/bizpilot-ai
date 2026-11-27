import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Payment provider adapters for the local (Pakistan) rails.
 *
 * The manual flow in `/billing/local` needs no gateway: the customer transfers into
 * the owner's own SadaPay/JazzCash/EasyPaisa/bank account and a human approves it.
 * This module is the *upgrade path* for the day a merchant account exists — the
 * same approval logic runs, except the signal comes from a signed webhook instead
 * of a button.
 *
 * Design rules, because payments are where a "best guess" loses real money:
 *
 *  1. A provider is only usable when its secret is configured. With no secret the
 *     webhook route answers 503 instead of trusting the request body.
 *  2. Signatures are compared in constant time over the *raw* body/params — never
 *     over a re-serialised object, which is how signature checks get bypassed.
 *  3. Verification returns a normalised event so the approval code has no provider
 *     specific branches. Anything unknown is `ignored`, never `paid`.
 *  4. Amounts are normalised to minor units (paisa) here, in one place, with the
 *     unit taken from the field name (`amount_cents`/`pp_Amount` = paisa,
 *     `amount` = rupees).
 */

export type NormalizedPaymentEvent = {
  provider: string;
  /** The provider's own payment id — the idempotency key. */
  paymentId: string;
  status: "paid" | "failed" | "ignored";
  /** Amount in minor units (paisa). */
  amountCents: number;
  currency: string;
  /** Transfer note / bill reference, e.g. BP-ACME. Normalised to upper case. */
  reference: string | null;
  /** Non-secret summary kept in the audit log. */
  summary: Record<string, string>;
};

export type VerificationResult =
  | { ok: true; event: NormalizedPaymentEvent }
  | { ok: false; status: 400 | 401 | 503; message: string };

export type PaymentProvider = {
  name: string;
  /** Env vars that must exist before this provider is considered live. */
  requiredEnv: string[];
  isConfigured: () => boolean;
  verifyWebhook: (raw: string, headers: Headers) => VerificationResult;
};

/** True only when every named env var has a non-empty value. */
export function envConfigured(keys: string[]): boolean {
  return keys.every((key) => (process.env[key] ?? "").trim().length > 0);
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** HMAC-SHA256 in hex; `upper` matches gateways that publish upper-case hashes. */
export function hmacHex(secret: string, payload: string, upper = false): string {
  const digest = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return upper ? digest.toUpperCase() : digest;
}

/**
 * Transfer notes are typed by humans, so they arrive with spaces, lower case and
 * stray punctuation. Normalising both sides is what makes matching possible.
 */
export function normalizeReference(value: string | null | undefined): string | null {
  const cleaned = (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  return cleaned.length >= 3 ? cleaned : null;
}

/** Rupees ("12500.50") → paisa (1250050). Returns 0 for anything unusable. */
export function rupeesToCents(value: string | number | null | undefined): number {
  const raw = typeof value === "number" ? String(value) : (value ?? "").trim().replace(/[,\s]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return 0;
  return Math.round(Number(raw) * 100);
}

/** A provider-supplied paisa amount, accepting integers only. */
export function paisaToCents(value: string | number | null | undefined): number {
  const raw = typeof value === "number" ? String(value) : (value ?? "").trim().replace(/[,\s]/g, "");
  if (!/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

/** Reads the first present, non-empty field from a bag of aliases. */
export function pickField(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

const PAID_WORDS = new Set(["paid", "succeeded", "success", "successful", "completed", "complete", "captured", "settled"]);
const FAILED_WORDS = new Set(["failed", "failure", "declined", "cancelled", "canceled", "expired", "reversed"]);

/** Maps a provider status word onto our three states; unknown words are ignored. */
export function statusFromWord(word: string | null): "paid" | "failed" | "ignored" {
  const value = (word ?? "").trim().toLowerCase();
  if (PAID_WORDS.has(value)) return "paid";
  if (FAILED_WORDS.has(value)) return "failed";
  return "ignored";
}

/** JSON body helper — a malformed body is a 400, never a crash. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
