import { NextResponse } from "next/server";
import { engineName } from "@/lib/db";
import { checkSchemaHealth } from "@/lib/health";
import { logger } from "@/lib/logger";

/**
 * Liveness probe. Says nothing sensitive and nothing about customers: which engine is
 * connected, whether the schema is in place, and how long a real query took. Used by
 * the Docker healthcheck and to verify a deployment.
 *
 * It used to also report the total number of leads in the database. That is a
 * cross-tenant business metric — "how big is this SaaS, and how is it doing" —
 * published to anonymous callers on a public URL, so it is gone.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  const engine = engineName();
  try {
    const health = checkSchemaHealth();
    return NextResponse.json(
      {
        ok: health.ok,
        engine: health.engine,
        migrated: health.plans >= 4 && health.missingColumns.length === 0,
        tables: health.tables,
        plans: health.plans,
        latencyMs: Date.now() - started,
        time: new Date().toISOString(),
      },
      { status: health.ok ? 200 : 503 }
    );
  } catch (error) {
    // Log the detail, return "unreachable": an exception message can carry a
    // connection string, a host name or a driver's internals.
    logger.error("health: database check failed", {
      error: error instanceof Error ? error.message : String(error),
      engine,
    });
    return NextResponse.json(
      { ok: false, engine, error: "database unreachable", latencyMs: Date.now() - started },
      { status: 503 }
    );
  }
}
