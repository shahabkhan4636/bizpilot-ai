import { NextResponse, type NextRequest } from "next/server";

/**
 * Per-request hardening.
 *
 * 1. A nonce is minted for every document request and used in the CSP, so
 *    `script-src` no longer needs `'unsafe-inline'` — Next attaches the nonce to
 *    its own hydration/bootstrap scripts (it reads the CSP we set on the *request*
 *    headers) and `'strict-dynamic'` lets those trusted scripts load the rest.
 * 2. A request id is attached to the response so a user-visible error digest can
 *    be correlated with the server log line that produced it.
 *
 * `style-src` keeps `'unsafe-inline'`: CSP has no nonce mechanism for inline
 * style *attributes*, which React uses for chart geometry, and the risk surface
 * of a style attribute is far smaller than a script.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("x-request-id", request.headers.get("x-request-id") ?? crypto.randomUUID());
  return response;
}

export const config = {
  // Documents only: API routes and static assets do not need a nonce, and
  // skipping them keeps the middleware off the hot path for assets.
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
