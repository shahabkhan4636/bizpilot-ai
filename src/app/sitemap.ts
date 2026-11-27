import { appUrl } from "@/lib/app-url";
import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = appUrl();
  const routes = ["", "/features", "/pricing", "/help", "/privacy", "/terms", "/signup", "/login"];
  return routes.map((r) => ({
    url: `${base}${r}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: r === "" ? 1 : 0.7,
  }));
}
