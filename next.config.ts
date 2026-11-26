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
        ],
      },
    ];
  },
};

export default nextConfig;
