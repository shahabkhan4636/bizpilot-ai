import { describe, it, expect, beforeEach } from "vitest";
import { resetDatabaseForTests, run } from "@/lib/db";
import { newId } from "@/lib/ids";
import { nowIso } from "@/lib/utils";
import { REQUIRED_COLUMNS, checkSchemaHealth } from "@/lib/health";

/**
 * Health probes.
 *
 * `/api/health` is public by design — a load balancer, a Docker healthcheck or an
 * uptime monitor has to reach it without credentials. That makes it the easiest place
 * in the app to leak something by accident, and it was leaking the total number of
 * leads (a cross-tenant business metric) plus raw exception text.
 *
 * It also had its own idea of what "the schema is in place" means, different from
 * readiness. One implementation now answers for both.
 */

beforeEach(() => {
  resetDatabaseForTests();
});

describe("the shared schema check", () => {
  it("reports shape, never customer content", () => {
    const now = nowIso();
    run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
      newId(),
      "customer@example.com",
      null,
      "Paying Customer",
      now,
      now,
    ]);

    const health = checkSchemaHealth();
    const serialised = JSON.stringify(health);
    expect(serialised).not.toContain("customer@example.com");
    expect(serialised).not.toContain("Paying Customer");
    // Shape is what it is for.
    expect(health.plans).toBeGreaterThanOrEqual(4);
    expect(health.tables).toBeGreaterThan(20);
    expect(health.missingColumns).toEqual([]);
    expect(health.ok).toBe(true);
  });

  it("probes the newest columns the code reads, so a half-migrated DB fails", () => {
    const health = checkSchemaHealth();
    expect(REQUIRED_COLUMNS.length).toBeGreaterThanOrEqual(3);
    expect(health.missingColumns).toEqual([]);
  });
});

describe("/api/health", () => {
  it("does not publish tenant metrics or raw database errors", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The leak that was fixed: how many leads every customer combined has.
    expect(body).not.toHaveProperty("leads");
    expect(JSON.stringify(body)).not.toMatch(/password|secret|token|connectionstring/i);
  });

  it("agrees with readiness about the schema", async () => {
    const [healthRoute, readinessRoute] = await Promise.all([
      import("@/app/api/health/route"),
      import("@/app/api/readiness/route"),
    ]);
    const health = (await (await healthRoute.GET()).json()) as { ok: boolean; migrated: boolean };
    const readiness = (await (await readinessRoute.GET()).json()) as {
      ready: boolean;
      checks: Record<string, { ok: boolean }>;
    };

    // Before this fix, health only counted rows in `plans`, so it could report
    // "healthy" on a database that readiness (correctly) refused to trust.
    expect(health.migrated).toBe(readiness.checks.schema_columns.ok);
    expect(health.ok).toBe(readiness.ready);
  });
});
