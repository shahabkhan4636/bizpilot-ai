import { NextResponse } from "next/server";
import { all, engineName, get } from "@/lib/db";
import { isEmailConfigured } from "@/lib/email";
import { isStripeConfigured } from "@/lib/stripe";
import { logger } from "@/lib/logger";

/**
 * Readiness probe: is this instance able to serve paying customers right now?
 *
 * Differs from /api/health (liveness): readiness checks that the schema is in
 * place, and reports — without failing the probe — which external providers are
 * configured. A deployment with no Stripe key can serve the app but cannot take
 * money, and an operator should be able to see that in one request.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    const plans = Number(get<{ c: number }>("select count(*) as c from plans")?.c ?? 0);
    checks.schema = { ok: plans >= 4, detail: `${plans} plans` };

    const migrations =
      engineName() === "postgres"
        ? Number(get<{ c: number }>("select count(*) as c from schema_migrations")?.c ?? 0)
        : all("select name from sqlite_master where type='table' and name='schema_migrations'").length;
    checks.migrations = { ok: migrations > 0, detail: `${migrations} applied` };
  } catch (error) {
    logger.error("readiness: database check failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ ready: false, checks, engine: engineName() }, { status: 503 });
  }

  const providers = {
    stripe: isStripeConfigured(),
    email: isEmailConfigured(),
    ai: Boolean(process.env.AI_API_KEY),
    dropbox: (process.env.DROPBOX_ACCESS_TOKEN ?? "").trim().length > 0,
  };

  const warnings = Object.entries(providers)
    .filter(([, configured]) => !configured)
    .map(([name]) => `${name} is not configured`);

  // Configured but unusable-for-accounting is a real operational gap: tokens will
  // be recorded but the spend cannot be priced, so say so instead of showing $0.
  if (
    providers.ai &&
    !(process.env.AI_PRICE_INPUT_PER_MTOK ?? "").trim() &&
    !(process.env.AI_PRICE_OUTPUT_PER_MTOK ?? "").trim()
  ) {
    warnings.push("ai is configured but AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK are empty, so cost is not priced");
  }

  const ready = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    {
      ready,
      engine: engineName(),
      checks,
      providers,
      // A provider being absent is a configuration gap, not an outage.
      warnings,
      time: new Date().toISOString(),
    },
    { status: ready ? 200 : 503 }
  );
}
