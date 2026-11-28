import { headers } from "next/headers";
import { appUrl } from "./app-url";

/**
 * The base URL for absolute links built *inside a request*: password resets,
 * invitation links, email-verification links and Stripe return URLs.
 *
 * Three modules had grown their own copy of this (with slightly different fallbacks),
 * so a change to how the deployment's URL is resolved had to be made in four places
 * and was, in practice, made in one. Order of preference:
 *
 *   1. `NEXT_PUBLIC_APP_URL` — explicit, and the only correct value for a custom domain
 *      when the app sits behind a proxy that rewrites `Host`;
 *   2. the request's own `Host` (plus `x-forwarded-proto`) — correct in local
 *      development and on any platform that preserves the header;
 *   3. whatever `appUrl()` resolves (Vercel's own URL, then localhost) — so a call made
 *      outside a request context still returns something usable instead of throwing.
 */
export async function requestAppUrl(): Promise<string> {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  try {
    const h = await headers();
    const host = h.get("host");
    if (host) return `${h.get("x-forwarded-proto") ?? "https"}://${host}`;
  } catch {
    // No request scope (a script, a test, a background job): fall through.
  }

  return appUrl();
}
