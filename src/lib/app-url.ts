/**
 * The public base URL of this deployment.
 *
 * Share links, PDF footers, Stripe redirects, OAuth callbacks, `robots.txt` and the
 * sitemap all need an absolute URL. On a hosted platform the correct value is only
 * known after the first deploy, so:
 *
 *   1. `NEXT_PUBLIC_APP_URL` wins (explicit, correct for a custom domain);
 *   2. otherwise Vercel's own `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` is used,
 *      so a deployment is correct even if nobody set the variable — previously every
 *      one of these call sites fell back to `http://localhost:3000`, which silently
 *      produced share links the client could never open;
 *   3. otherwise local development.
 *
 * There is no trailing slash, so callers can append `/path` without doubling up.
 */
export function appUrl(): string {
  const explicit = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (explicit) return stripTrailingSlash(explicit);

  const vercelHost = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL ?? "").trim();
  if (vercelHost) return stripTrailingSlash(`https://${vercelHost}`);

  return "http://localhost:3000";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
