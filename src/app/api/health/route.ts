import { NextResponse } from "next/server";
import { all, engineName, get } from "@/lib/db";

/**
 * Health probe. Says nothing sensitive: which engine is connected, whether the
 * schema is in place and how long a real query took. Used by the Docker
 * healthcheck and to verify a deployment.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  const engine = engineName();
  try {
    const plans = Number(get<{ c: number }>("select count(*) as c from plans")?.c ?? 0);
    const leads = Number(get<{ c: number }>("select count(*) as c from leads")?.c ?? 0);
    const tables =
      engine === "postgres"
        ? Number(
            get<{ c: number }>(
              "select count(*) as c from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
            )?.c ?? 0
          )
        : all("select name from sqlite_master where type='table'").length;

    const ok = plans >= 4;
    return NextResponse.json(
      {
        ok,
        engine,
        migrated: ok,
        tables,
        plans,
        leads,
        latencyMs: Date.now() - started,
        time: new Date().toISOString(),
      },
      { status: ok ? 200 : 503 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        engine,
        error: error instanceof Error ? error.message : "database unreachable",
        latencyMs: Date.now() - started,
      },
      { status: 503 }
    );
  }
}
