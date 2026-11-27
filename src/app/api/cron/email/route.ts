import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { dispatchQueuedEmails, outboxCounts } from "@/lib/email-outbox";

/**
 * Email retry worker.
 *
 *   GET /api/cron/email                 dispatch every due row
 *   GET /api/cron/email?dryRun=1        report the queue without sending
 *   Authorization: Bearer $CRON_SECRET
 *
 * Authenticated with `CRON_SECRET` for the same reason as the automation
 * scheduler: without it this route would let anyone drain (and rate-limit) the
 * deployment's email quota.
 *
 * When Resend is not configured the route still answers 200 with
 * `configured: false` and the queue depth — the rows are safe, not lost.
 */
export const dynamic = "force-dynamic";

function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const alt = request.headers.get("x-cron-secret") ?? "";
  return (bearer.length > 0 && bearer === secret) || (alt.length > 0 && alt === secret);
}

async function handle(request: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json(
      { error: "Scheduling is not configured", detail: "Set CRON_SECRET to enable the email retry worker." },
      { status: 503 }
    );
  }
  if (!authorized(request, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dryRun") === "1";
  const before = outboxCounts();

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, queue: before }, { status: 200 });
  }

  try {
    const summary = await dispatchQueuedEmails({ limit: Number(url.searchParams.get("limit") ?? 25) });
    logger.info("cron email dispatch", { ...summary });
    return NextResponse.json({ ok: true, ...summary, before, after: outboxCounts() }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Email dispatch failed";
    logger.error("cron email dispatch failed", { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
