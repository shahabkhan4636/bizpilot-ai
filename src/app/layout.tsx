import type { Metadata } from "next";
import "./globals.css";
import { headers } from "next/headers";
import { THEME_BOOTSTRAP } from "@/lib/theme";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"),
  title: {
    default: "BizPilot AI — AI business automation for small teams",
    template: "%s · BizPilot AI",
  },
  description:
    "BizPilot AI helps small businesses capture leads, qualify them, generate proposals and automate follow-ups — in one workspace.",
  keywords: ["CRM", "sales automation", "AI sales assistant", "proposals", "small business software"],
  openGraph: {
    title: "BizPilot AI",
    description: "Capture leads, qualify them with AI, send proposals and automate follow-ups.",
    type: "website",
    url: "/",
  },
  robots: { index: true, follow: true },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading headers() opts every route into dynamic rendering, which is what a
  // nonce-based CSP requires — a cached page cannot carry a fresh nonce.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
