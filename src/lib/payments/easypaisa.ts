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
 * Easypaisa merchant callback adapter.
 *
 * Easypaisa signs callbacks as an HMAC-SHA256 hash over the key-sorted parameters
 * with the merchant's hash key, carried in the payload itself. Field names differ
 * from JazzCash's `pp_*` prefixes, so aliases are listed explicitly and the status
 * word is mapped through the shared table (`Paid`/`Completed` → paid).
 *
 * As with the other two adapters, the secret is the whole gate: with no
 * `EASYPAISA_HASH_KEY` the provider reports itself unconfigured and the webhook
 * route answers 503 rather than trusting anything in the body.
 */

function hashKey(): string {
  return (process.env.EASYPAISA_HASH_KEY ?? "").trim();
}

export function easypaisaHash(params: Record<string, string>, key: string): string {
  const fields = Object.keys(params)
    .filter((name) => name !== "hash" && name !== "Hash" && params[name] !== "")
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return hmacHex(key, `${key}&${fields}`, true);
}

export const easypaisaProvider: PaymentProvider = {
  name: "easypaisa",
  requiredEnv: ["EASYPAISA_HASH_KEY"],
  isConfigured: () => envConfigured(["EASYPAISA_HASH_KEY"]),

  verifyWebhook(raw: string, _headers: Headers): VerificationResult {
    const key = hashKey();
    if (!key) {
      return { ok: false, status: 503, message: "Easypaisa callbacks are not configured. Set EASYPAISA_HASH_KEY." };
    }

    const params: Record<string, string> = {};
    for (const [name, value] of new URLSearchParams(raw)) params[name] = value;

    const provided = (params.hash ?? params.Hash ?? "").trim().toUpperCase();
    if (!provided) return { ok: false, status: 401, message: "Missing hash" };
    if (!safeEqual(easypaisaHash(params, key), provided)) {
      return { ok: false, status: 401, message: "Hash does not match the posted fields" };
    }

    const paymentId = pickField(params, ["transactionId", "transaction_id", "orderId", "order_id", "txnRefNo"]);
    if (!paymentId) return { ok: false, status: 400, message: "No transaction id in the payload" };

    const word = pickField(params, ["status", "transactionStatus", "responseCode"]);
    const status = word === "000" ? "paid" : statusFromWord(word);

    return {
      ok: true,
      event: {
        provider: "easypaisa",
        paymentId,
        status,
        amountCents: paisaToCents(pickField(params, ["amountCents", "amount_cents"])) || rupeesToCents(pickField(params, ["amount", "transactionAmount"])),
        currency: (pickField(params, ["currency"]) ?? "PKR").toUpperCase(),
        reference: normalizeReference(pickField(params, ["billReference", "reference", "orderId", "description"])),
        summary: { status: word ?? "unknown", amount: pickField(params, ["amount", "transactionAmount"]) ?? "0" },
      },
    };
  },
};
