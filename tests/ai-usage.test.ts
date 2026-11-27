import { describe, it, expect, beforeEach, vi } from "vitest";
import { run, resetDatabaseForTests } from "@/lib/db";
import { newId, newToken } from "@/lib/ids";
import { nowIso, addDays } from "@/lib/utils";
import { recordAiUsage, aiUsageThisMonth, costOf, hasAiUsageThisMonth } from "@/lib/ai-usage";

/** A workspace with one organisation row, nothing else. */
function seedOrg(): string {
  resetDatabaseForTests();
  const now = nowIso();
  const userId = newId();
  const orgId = newId();
  const slug = `ai-${newToken(4).toLowerCase()}`;
  run("insert into profiles (id, email, password_hash, full_name, created_at, updated_at) values (?,?,?,?,?,?)", [
    userId, `${slug}@example.com`, "x", "T", now, now,
  ]);
  run("insert into organizations (id, name, slug, created_at, updated_at) values (?,?,?,?,?)", [orgId, "AI Org", slug, now, now]);
  run("insert into organization_members (id, organization_id, user_id, role, created_at) values (?,?,?,?,?)", [
    newId(), orgId, userId, "owner", now,
  ]);
  run(
    "insert into subscriptions (id, organization_id, plan_code, status, billing_cycle, trial_ends_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)",
    [newId(), orgId, "professional", "trialing", "monthly", addDays(14).toISOString(), now, now]
  );
  return orgId;
}

describe("AI token and cost accounting", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("prices tokens from configured per-million rates", () => {
    vi.stubEnv("AI_PRICE_INPUT_PER_MTOK", "3"); // $3 / 1M input tokens
    vi.stubEnv("AI_PRICE_OUTPUT_PER_MTOK", "15"); // $15 / 1M output tokens
    // 1,000,000 input + 1,000,000 output = 3 + 15 = $18
    expect(costOf(1_000_000, 1_000_000)).toBe(18);
    // 1,000 input + 200 output = 0.003 + 0.003 = $0.006
    expect(costOf(1_000, 200)).toBeCloseTo(0.006, 6);
    expect(costOf(0, 0)).toBe(0);
  });

  it("reports cost as unknown, not as zero, when no prices are configured", () => {
    vi.stubEnv("AI_PRICE_INPUT_PER_MTOK", "");
    vi.stubEnv("AI_PRICE_OUTPUT_PER_MTOK", "");
    expect(costOf(5000, 5000)).toBeNull();
  });

  it("records tokens even when the price is unknown, and totals them per model", () => {
    const orgId = seedOrg();
    vi.stubEnv("AI_PRICE_INPUT_PER_MTOK", "");
    vi.stubEnv("AI_PRICE_OUTPUT_PER_MTOK", "");

    const first = recordAiUsage({
      organizationId: orgId,
      provider: "api.openai.com",
      model: "gpt-4o-mini",
      promptTokens: 1200,
      completionTokens: 300,
    });
    recordAiUsage({
      organizationId: orgId,
      provider: "api.openai.com",
      model: "gpt-4o-mini",
      promptTokens: 800,
      completionTokens: 200,
    });

    expect(first).toEqual({ tokens: 1500, costUsd: null });
    const summary = aiUsageThisMonth(orgId);
    expect(summary.totalTokens).toBe(2500);
    expect(summary.promptTokens).toBe(2000);
    expect(summary.completionTokens).toBe(500);
    expect(summary.costUsd).toBeNull(); // unpriced, so not claimed as $0.00
    expect(summary.byModel[0]).toMatchObject({ model: "gpt-4o-mini", tokens: 2500 });
    expect(hasAiUsageThisMonth(orgId)).toBe(true);
  });

  it("sums a priced month to the expected dollars and keeps models separate", () => {
    const orgId = seedOrg();
    vi.stubEnv("AI_PRICE_INPUT_PER_MTOK", "3");
    vi.stubEnv("AI_PRICE_OUTPUT_PER_MTOK", "15");

    recordAiUsage({
      organizationId: orgId,
      provider: "api.openai.com",
      model: "gpt-4o-mini",
      promptTokens: 1_000_000,
      completionTokens: 0,
    }); // $3.00
    recordAiUsage({
      organizationId: orgId,
      provider: "api.openai.com",
      model: "gpt-4o",
      promptTokens: 0,
      completionTokens: 100_000,
    }); // $1.50

    const summary = aiUsageThisMonth(orgId);
    expect(summary.costUsd).toBeCloseTo(4.5, 6);
    expect(summary.totalTokens).toBe(1_100_000);
    const models = summary.byModel.map((m) => m.model).sort();
    expect(models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("never lets one workspace see another workspace's spend", () => {
    const orgA = seedOrg();
    vi.stubEnv("AI_PRICE_INPUT_PER_MTOK", "3");
    vi.stubEnv("AI_PRICE_OUTPUT_PER_MTOK", "15");
    recordAiUsage({
      organizationId: orgA,
      provider: "p",
      model: "m",
      promptTokens: 1_000_000,
      completionTokens: 0,
    });

    const orgB = seedOrg();
    const summaryB = aiUsageThisMonth(orgB);
    expect(summaryB.totalTokens).toBe(0);
    expect(summaryB.costUsd).toBeNull();
    expect(hasAiUsageThisMonth(orgB)).toBe(false);
  });
});
