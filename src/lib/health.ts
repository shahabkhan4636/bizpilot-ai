import { all, engineName, get } from "./db";

/**
 * Schema health, computed once for both probes.
 *
 * `/api/health` (liveness) and `/api/readiness` (can this instance serve paying
 * customers?) used to answer this question with two hand-written implementations.
 * They had already drifted: health only counted rows in `plans`, so a half-migrated
 * database passed liveness while readiness failed it. One implementation means the
 * two probes can never disagree about the database again.
 *
 * Nothing here is customer data — it is shape, not content.
 */

export type SchemaHealth = {
  /** True when the database is reachable and carries the expected schema. */
  ok: boolean;
  engine: "sqlite" | "postgres";
  /** Rows in `plans`, which is seeded by the schema itself. */
  plans: number;
  /** Rows in `schema_migrations`. */
  migrations: number;
  /** Number of base tables in the default/public schema. */
  tables: number;
  /** `table.column` pairs the code depends on but the database does not have. */
  missingColumns: string[];
};

/**
 * The newest columns the application code actually reads.
 *
 * Existence of a *table* proves nothing about *which* schema it is; probing a column
 * makes a half-migrated database fail the probe instead of throwing `no such column`
 * at a customer.
 */
export const REQUIRED_COLUMNS: [table: string, column: string][] = [
  ["automations", "schedule_interval_minutes"],
  ["integration_credentials", "provider"],
  ["proposals", "accepted_by_name"],
];

/** The minimum number of plans the pricing page needs to work at all. */
const MINIMUM_PLANS = 4;

export function checkSchemaHealth(): SchemaHealth {
  const engine = engineName();

  const plans = Number(get<{ c: number }>("select count(*) as c from plans")?.c ?? 0);
  const migrations = Number(get<{ c: number }>("select count(*) as c from schema_migrations")?.c ?? 0);
  const tables =
    engine === "postgres"
      ? Number(
          get<{ c: number }>(
            "select count(*) as c from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"
          )?.c ?? 0
        )
      : all("select name from sqlite_master where type='table'").length;

  const missingColumns: string[] = [];
  for (const [table, column] of REQUIRED_COLUMNS) {
    try {
      all(`select ${column} from ${table} limit 1`);
    } catch {
      missingColumns.push(`${table}.${column}`);
    }
  }

  return {
    ok: plans >= MINIMUM_PLANS && migrations > 0 && missingColumns.length === 0,
    engine,
    plans,
    migrations,
    tables,
    missingColumns,
  };
}
