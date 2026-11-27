import { all, get } from "@/lib/db";
import { recordUsage } from "@/lib/plans";

/**
 * Token and cost accounting for AI calls.
 *
 * Two questions have to be answerable from the database alone: "how much did this
 * workspace spend on AI this month" and "which model produced this draft". Token
 * counts come from the provider's own `usage` object — never estimated — and cost
 * is derived from per-million-token prices supplied by configuration, so a price
 * change is an env change rather than a code change. When prices are not set the
 * tokens are still recorded and the cost is reported as unknown rather than zero,
 * because a confident $0.00 is worse than "not priced".
 */

export type AiUsageInput = {
  organizationId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

export type AiUsageSummary = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  byModel: { model: string; calls: number; tokens: number; costUsd: number | null }[];
};

function pricePerMillion(kind: "input" | "output"): number | null {
  const raw = process.env[kind === "input" ? "AI_PRICE_INPUT_PER_MTOK" : "AI_PRICE_OUTPUT_PER_MTOK"];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Cost in USD for one call, or null when the provider's prices are not configured. */
export function costOf(promptTokens: number, completionTokens: number): number | null {
  const input = pricePerMillion("input");
  const output = pricePerMillion("output");
  if (input === null && output === null) return null;
  const cost = (promptTokens * (input ?? 0) + completionTokens * (output ?? 0)) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function recordAiUsage(input: AiUsageInput): { tokens: number; costUsd: number | null } {
  const promptTokens = Math.max(0, Math.round(input.promptTokens));
  const completionTokens = Math.max(0, Math.round(input.completionTokens));
  const tokens = promptTokens + completionTokens;
  const costUsd = costOf(promptTokens, completionTokens);

  if (tokens > 0) {
    recordUsage(input.organizationId, "ai_tokens", tokens, {
      provider: input.provider,
      model: input.model,
      promptTokens,
      completionTokens,
    });
  }
  if (costUsd !== null && costUsd > 0) {
    // Micro-dollars as an integer keeps the metric column exact.
    recordUsage(input.organizationId, "ai_cost_micros", Math.round(costUsd * 1_000_000), {
      provider: input.provider,
      model: input.model,
    });
  }
  return { tokens, costUsd };
}

function monthStartIso(): string {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

/**
 * Aggregates this month's AI usage. Rows are read once and grouped in memory: the
 * per-model breakdown would otherwise need engine-specific JSON SQL.
 */
export function aiUsageThisMonth(organizationId: string): AiUsageSummary {
  const rows = all<{ metric: string; quantity: number; metadata: string; created_at: string }>(
    "select metric, quantity, metadata, created_at from usage_records where organization_id = ? and metric in ('ai_tokens','ai_cost_micros','ai_generation') and created_at >= ?",
    [organizationId, monthStartIso()]
  );

  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costMicros = 0;
  let costKnown = false;
  const byModel = new Map<string, { calls: number; tokens: number; costUsd: number | null }>();

  for (const row of rows) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      meta = {};
    }
    const model = typeof meta.model === "string" && meta.model ? meta.model : "unknown";

    if (row.metric === "ai_generation") {
      calls += row.quantity;
      const entry = byModel.get(model) ?? { calls: 0, tokens: 0, costUsd: null };
      entry.calls += row.quantity;
      byModel.set(model, entry);
      continue;
    }
    if (row.metric === "ai_tokens") {
      promptTokens += Number(meta.promptTokens ?? 0);
      completionTokens += Number(meta.completionTokens ?? 0);
      const entry = byModel.get(model) ?? { calls: 0, tokens: 0, costUsd: null };
      entry.tokens += row.quantity;
      byModel.set(model, entry);
      continue;
    }
    // ai_cost_micros
    costMicros += row.quantity;
    costKnown = true;
    const entry = byModel.get(model) ?? { calls: 0, tokens: 0, costUsd: null };
    entry.costUsd = (entry.costUsd ?? 0) + row.quantity / 1_000_000;
    byModel.set(model, entry);
  }

  return {
    calls,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: costKnown ? Math.round(costMicros) / 1_000_000 : null,
    byModel: [...byModel.entries()]
      .map(([model, entry]) => ({ model, ...entry }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}

/** True when at least one usage row exists this month — used for empty states. */
export function hasAiUsageThisMonth(organizationId: string): boolean {
  const row = get<{ c: number }>(
    "select count(*) as c from usage_records where organization_id = ? and metric in ('ai_tokens','ai_generation') and created_at >= ?",
    [organizationId, monthStartIso()]
  );
  return (row?.c ?? 0) > 0;
}
