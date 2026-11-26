import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multiple lockfiles exist in this workspace; pin the trace root to this app.
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["better-sqlite3"],
  eslint: { ignoreDuringBuilds: false },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // HSTS: browsers ignore it over plain HTTP, so it is safe in dev and
          // correct the moment the app is served over TLS.
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          // Next injects hydration data as inline scripts and Tailwind ships a
          // stylesheet, so 'unsafe-inline' is required for those two directives
          // only — everything else is locked to this origin.
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "form-action 'self'",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
