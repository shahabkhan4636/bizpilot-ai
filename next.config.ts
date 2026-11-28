import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multiple lockfiles exist in this workspace; pin the trace root to this app.
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["better-sqlite3", "pg"],
  /**
   * The Postgres engine runs its connection inside a worker thread
   * (scripts/pg-worker.mjs, see src/lib/pg-sync.ts), and that worker imports
   * `pg` at runtime. File tracing cannot see either dependency statically, so
   * on Vercel the function shipped without them: the worker failed to start,
   * the main thread waited on Atomics until the 120s timeout, and every API
   * route hung. Ship them explicitly — worker file plus `pg` and its
   * transitive dependencies.
   */
  outputFileTracingIncludes: {
    "/**/*": [
      "./scripts/pg-worker.mjs",
      // Belt and braces: `pg` is imported statically in src/lib/pg-sync.ts so the
      // tracer walks its whole tree, and these globs keep the worker's runtime
      // dependencies present even if a transitive package is skipped.
      "./node_modules/xtend/**",
      "./node_modules/pg/**",
      "./node_modules/pg-*/**",
      "./node_modules/pgpass/**",
      "./node_modules/split2/**",
      "./node_modules/pg-int8/**",
      "./node_modules/postgres-array/**",
      "./node_modules/postgres-bytea/**",
      "./node_modules/postgres-date/**",
      "./node_modules/postgres-interval/**",
    ],
  },
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
          // CSP is issued per request by src/middleware.ts so it can carry a nonce.
        ],
      },
    ];
  },
};

export default nextConfig;
