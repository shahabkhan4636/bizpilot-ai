import type { Metadata } from "next";
import "./globals.css";
import { ThemeScript } from "@/components/theme-toggle";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
