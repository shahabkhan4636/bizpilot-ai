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

    // Rows, not "does the table exist": the old SQLite branch counted the table
    // and cheerfully reported "1 applied" on a database with seven migrations.
    const migrations = Number(get<{ c: number }>("select count(*) as c from schema_migrations")?.c ?? 0);
    checks.migrations = { ok: migrations > 0, detail: `${migrations} applied` };

    // Existence counts prove nothing about *which* schema this is. Probe for the
    // newest columns the code relies on, so a half-migrated database fails the
    // probe instead of throwing "no such column" at a customer.
    const required: [string, string][] = [
      ["automations", "schedule_interval_minutes"],
      ["integration_credentials", "provider"],
      ["proposals", "accepted_by_name"],
    ];
    const missing: string[] = [];
    for (const [table, column] of required) {
      try {
        all(`select ${column} from ${table} limit 1`);
      } catch {
        missing.push(`${table}.${column}`);
      }
    }
    checks.schema_columns = missing.length === 0
      ? { ok: true, detail: `${required.length} recent columns present` }
      : { ok: false, detail: `missing ${missing.join(", ")} — run npm run db:migrate` };
  } catch (error) {
    logger.error("readiness: database check failed", { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ ready: false, checks, engine: engineName() }, { status: 503 });
  }

  const providers = {
    stripe: isStripeConfigured(),
    email: isEmailConfigured(),
    ai: Boolean(process.env.AI_API_KEY),
    dropbox:
      ((process.env.DROPBOX_APP_KEY ?? "").trim().length > 0 &&
        (process.env.DROPBOX_APP_SECRET ?? "").trim().length > 0) ||
      (process.env.DROPBOX_ACCESS_TOKEN ?? "").trim().length > 0,
    // Time-based automations need a scheduler; event triggers work without it.
    scheduler: (process.env.CRON_SECRET ?? "").trim().length > 0,
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
