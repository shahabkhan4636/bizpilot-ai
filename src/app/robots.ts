import { appUrl } from "@/lib/app-url";
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = appUrl();
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/dashboard", "/leads", "/customers", "/admin", "/api/"] }],
    sitemap: `${base}/sitemap.xml`,
  };
}
