import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { engineName } from "@/lib/db";
import { runScheduler } from "@/lib/scheduler";

/**
 * Scheduler entry point.
 *
 * Point Vercel Cron (or any scheduler) at this route. It is authenticated with
 * `CRON_SECRET`: without that variable the route refuses to run at all rather
 * than running unauthenticated, because it dispatches emails and AI calls on
 * behalf of every workspace.
 *
 *   Authorization: Bearer $CRON_SECRET
 *   GET /api/cron/automations?dryRun=1     # report what would run, change nothing
 */
export const dynamic = "force-dynamic";

function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  // Some schedulers send a plain header instead of a bearer token.
  const alt = request.headers.get("x-cron-secret") ?? "";
  return bearer === secret || alt === secret;
}

async function handle(request: Request) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json(
      {
        error: "Scheduling is not configured",
        detail:
          "Set CRON_SECRET and point your scheduler at this route with an Authorization: Bearer header.",
      },
      { status: 503 }
    );
  }
  if (!authorized(request, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  const started = Date.now();
  try {
    const summary = await runScheduler({ dryRun });
    logger.info("cron automations run", {
      engine: engineName(),
      dryRun,
      scheduled: summary.scheduled.length,
      overdueFollowups: summary.overdueFollowups.length,
      ms: Date.now() - started,
    });
    return NextResponse.json({ ok: true, ...summary }, { status: 200 });
  } catch (error) {
    logger.error("cron automations run failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Scheduler failed" },
      { status: 500 }
    );
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
