import {
  envConfigured,
  hmacHex,
  normalizeReference,
  paisaToCents,
  pickField,
  rupeesToCents,
  safeEqual,
  statusFromWord,
  type PaymentProvider,
  type VerificationResult,
} from "./provider";

/**
 * JazzCash merchant webhook adapter.
 *
 * JazzCash signs its callbacks differently from SadaPay: `pp_SecureHash` is an
 * HMAC-SHA256 (upper-case hex) over the *sorted* form fields with the integrity
 * salt prepended, excluding the hash field itself. That is the scheme their
 * merchant integration guide documents, and it is what this implements — over the
 * raw `application/x-www-form-urlencoded` body, so re-serialisation cannot change
 * the bytes that were signed.
 *
 * Amount units: `pp_Amount` is in paisa (rupees × 100), unlike the rupee fields of
 * the JSON gateways, so it is normalised here rather than at the approval site.
 */

function salt(): string {
  return (process.env.JAZZCASH_INTEGRITY_SALT ?? "").trim();
}

/** Salt-prefixed, key-sorted, `&`-joined payload — JazzCash's documented input. */
export function jazzcashSecureHash(params: Record<string, string>, integritySalt: string): string {
  const fields = Object.keys(params)
    .filter((key) => key !== "pp_SecureHash" && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return hmacHex(integritySalt, `${integritySalt}&${fields}`, true);
}

export const jazzcashProvider: PaymentProvider = {
  name: "jazzcash",
  requiredEnv: ["JAZZCASH_INTEGRITY_SALT"],
  isConfigured: () => envConfigured(["JAZZCASH_INTEGRITY_SALT"]),

  verifyWebhook(raw: string, _headers: Headers): VerificationResult {
    const key = salt();
    if (!key) {
      return { ok: false, status: 503, message: "JazzCash webhooks are not configured. Set JAZZCASH_INTEGRITY_SALT" };
    }

    const params: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(raw)) params[name] = value;

    const provided = (params.pp_SecureHash ?? "").trim().toUpperCase();
    if (!provided) return { ok: false, status: 401, message: "Missing pp_SecureHash" };
    if (!safeEqual(jazzcashSecureHash(params, key), provided)) {
      return { ok: false, status: 401, message: "Secure hash does not match the posted fields" };
    }

    const paymentId = pickField(params, ["pp_TxnRefNo", "pp_RetreivalReferenceNo", "pp_BillReference"]);
    if (!paymentId) return { ok: false, status: 400, message: "No transaction reference in the payload" };

    // JazzCash's success code is 000; anything else is a failure, not a payment.
    const responseCode = (params.pp_ResponseCode ?? "").trim();
    const status = responseCode === "000" ? "paid" : responseCode ? "failed" : statusFromWord(pickField(params, ["pp_Status"]));

    return {
      ok: true,
      event: {
        provider: "jazzcash",
        paymentId,
        status,
        amountCents: paisaToCents(params.pp_Amount) || rupeesToCents(params.pp_Amount),
        currency: "PKR",
        reference: normalizeReference(params.pp_BillReference ?? pickField(params, ["pp_Description", "pp_TxnRefNo"])),
        summary: { responseCode: responseCode || "none", amount: params.pp_Amount ?? "0" },
      },
    };
  },
};
