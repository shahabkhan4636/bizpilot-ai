import {
  envConfigured,
  hmacHex,
  normalizeReference,
  parseJsonObject,
  pickField,
  rupeesToCents,
  paisaToCents,
  safeEqual,
  statusFromWord,
  type PaymentProvider,
  type VerificationResult,
} from "./provider";

/**
 * SadaPay (SADA BIZ) webhook adapter.
 *
 * What is real here: the signature scheme (HMAC-SHA256 over the raw request body,
 * compared in constant time), the amount unit handling, the idempotency key, and
 * the fact that nothing activates unless the signature matches.
 *
 * What is an assumption: the exact field names SadaPay's dashboard sends and the
 * header that carries the signature. Both are configurable —
 * `SADAPAY_SIGNATURE_HEADER` (default `x-sadapay-signature`) and the alias lists
 * below — because a merchant account that has not been issued yet cannot be tested.
 * When the merchant account arrives, one real webhook settles which alias is used;
 * no other code changes.
 */

export const SADAPAY_HEADER_DEFAULT = "x-sadapay-signature";

function secret(): string {
  return (process.env.SADAPAY_WEBHOOK_SECRET ?? "").trim();
}

export const sadapayProvider: PaymentProvider = {
  name: "sadapay",
  requiredEnv: ["SADAPAY_WEBHOOK_SECRET"],
  isConfigured: () => envConfigured(["SADAPAY_WEBHOOK_SECRET"]),

  verifyWebhook(raw: string, headers: Headers): VerificationResult {
    const key = secret();
    if (!key) {
      return { ok: false, status: 503, message: "SadaPay webhooks are not configured. Set SADAPAY_WEBHOOK_SECRET." };
    }

    const headerName = (process.env.SADAPAY_SIGNATURE_HEADER ?? SADAPAY_HEADER_DEFAULT).trim().toLowerCase();
    const provided = (headers.get(headerName) ?? "").trim().replace(/^sha256=/i, "");
    if (!provided) {
      return { ok: false, status: 401, message: `Missing ${headerName} header` };
    }

    const expected = hmacHex(key, raw);
    if (!safeEqual(expected, provided.toLowerCase())) {
      return { ok: false, status: 401, message: "Signature does not match the request body" };
    }

    const body = parseJsonObject(raw);
    if (!body) return { ok: false, status: 400, message: "Body is not a JSON object" };

    const paymentId = pickField(body, ["payment_id", "paymentId", "transaction_id", "transactionId", "id", "rrn"]);
    if (!paymentId) return { ok: false, status: 400, message: "No payment id in the payload" };

    const word = pickField(body, ["status", "payment_status", "event", "type"]);
    const status = statusFromWord(word);
    const amountCents = pickField(body, ["amount_cents", "amountCents"])
      ? paisaToCents(pickField(body, ["amount_cents", "amountCents"]))
      : rupeesToCents(pickField(body, ["amount", "amount_pkr", "amountPkr", "value"]));

    return {
      ok: true,
      event: {
        provider: "sadapay",
        paymentId,
        status,
        amountCents,
        currency: (pickField(body, ["currency", "currency_code"]) ?? "PKR").toUpperCase(),
        reference: normalizeReference(
          pickField(body, ["reference", "transfer_note", "narration", "description", "note", "remarks"])
        ),
        summary: {
          status: word ?? "unknown",
          amount: pickField(body, ["amount_cents", "amountCents", "amount", "amount_pkr"]) ?? "0",
        },
      },
    };
  },
};
