import { all, get, run } from "./db";
import { newId } from "./ids";
import { nowIso } from "./utils";

export type PlanRow = {
  code: string;
  name: string;
  price_monthly_cents: number;
  price_annual_cents: number;
  lead_limit: number;
  member_limit: number;
  ai_generation_limit: number;
  automation_limit: number;
  document_limit: number;
  features: string; // JSON
  is_active: number;
  sort_order: number;
};

export type PlanFeatures = {
  crm?: boolean;
  proposals?: boolean;
  ai_assistant?: boolean;
  automations?: boolean;
  documents?: boolean;
  analytics?: "basic" | "standard" | "advanced";
  multi_workspace?: boolean;
  white_label?: boolean;
};

export type EffectivePlan = PlanRow & { featuresParsed: PlanFeatures };

export const DEFAULT_PLAN_CODE = "starter";

export function listPlans(): EffectivePlan[] {
  return all<PlanRow>("select * from plans where is_active = 1 order by sort_order asc").map((p) => ({
    ...p,
    featuresParsed: safeParse<PlanFeatures>(p.features, {}),
  }));
}

export function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/** Plan actually in force for an org (falls back to Starter limits when no subscription row exists). */
export function getEffectivePlan(organizationId: string): EffectivePlan {
  const row = get<PlanRow & { sub_status?: string }>(
    `select pl.*, s.status as sub_status
       from plans pl
       left join subscriptions s on s.plan_code = pl.code and s.organization_id = ?
      where pl.code = coalesce((select plan_code from subscriptions where organization_id = ?), ?)
      limit 1`,
    [organizationId, organizationId, DEFAULT_PLAN_CODE]
  );
  const plan =
    row ??
    get<PlanRow>("select * from plans where code = ?", [DEFAULT_PLAN_CODE]) ??
    ({} as PlanRow);
  return { ...(plan as PlanRow), featuresParsed: safeParse<PlanFeatures>((plan as PlanRow).features, {}) };
}

/** Only paid/trialing subscriptions unlock paid features. */
export function subscriptionIsUsable(organizationId: string): boolean {
  const sub = get<{ status: string; trial_ends_at: string | null }>(
    "select status, trial_ends_at from subscriptions where organization_id = ?",
    [organizationId]
  );
  if (!sub) return false;
  if (sub.status === "active" || sub.status === "trialing") {
    if (sub.status === "trialing" && sub.trial_ends_at && new Date(sub.trial_ends_at) < new Date()) return false;
    return true;
  }
  return false;
}

export type UsageMetric =
  | "lead"
  | "ai_generation"
  | "ai_tokens"
  | "ai_cost_micros"
  | "document"
  | "automation_run"
  | "proposal";

export function usageThisMonth(organizationId: string, metric: UsageMetric): number {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const row = get<{ total: number | null }>(
    "select sum(quantity) as total from usage_records where organization_id = ? and metric = ? and created_at >= ?",
    [organizationId, metric, start.toISOString()]
  );
  return row?.total ?? 0;
}

export function recordUsage(organizationId: string, metric: UsageMetric, quantity = 1, metadata: Record<string, unknown> = {}) {
  run("insert into usage_records (id, organization_id, metric, quantity, metadata, created_at) values (?,?,?,?,?,?)", [
    newId(),
    organizationId,
    metric,
    quantity,
    JSON.stringify(metadata),
    nowIso(),
  ]);
}

export function leadCount(organizationId: string): number {
  const row = get<{ c: number }>(
    "select count(*) as c from leads where organization_id = ? and deleted_at is null",
    [organizationId]
  );
  return row?.c ?? 0;
}

export type LimitCheck = { allowed: boolean; reason?: string; used?: number; limit?: number };

/** Server-side plan enforcement. Never rely on the UI hiding a button. */
export function checkLeadLimit(organizationId: string): LimitCheck {
  const plan = getEffectivePlan(organizationId);
  const used = leadCount(organizationId);
  if (used >= plan.lead_limit) {
    return {
      allowed: false,
      reason: `Your ${plan.name} plan includes ${plan.lead_limit.toLocaleString()} leads. Upgrade to add more.`,
      used,
      limit: plan.lead_limit,
    };
  }
  return { allowed: true, used, limit: plan.lead_limit };
}

export function checkAiLimit(organizationId: string): LimitCheck {
  const plan = getEffectivePlan(organizationId);
  const used = usageThisMonth(organizationId, "ai_generation");
  if (used >= plan.ai_generation_limit) {
    return {
      allowed: false,
      reason: `You have used all ${plan.ai_generation_limit} AI generations on the ${plan.name} plan this month.`,
      used,
      limit: plan.ai_generation_limit,
    };
  }
  return { allowed: true, used, limit: plan.ai_generation_limit };
}

export function checkFeature(organizationId: string, feature: keyof PlanFeatures): LimitCheck {
  const plan = getEffectivePlan(organizationId);
  const enabled = Boolean(plan.featuresParsed[feature]);
  if (!enabled) {
    return { allowed: false, reason: `${feature.replace(/_/g, " ")} is not included in the ${plan.name} plan.` };
  }
  return { allowed: true };
}

export function checkDocumentLimit(organizationId: string): LimitCheck {
  const plan = getEffectivePlan(organizationId);
  const row = get<{ c: number }>("select count(*) as c from documents where organization_id = ?", [organizationId]);
  const used = row?.c ?? 0;
  if (used >= plan.document_limit) {
    return { allowed: false, reason: `Document storage limit (${plan.document_limit}) reached on the ${plan.name} plan.`, used, limit: plan.document_limit };
  }
  return { allowed: true, used, limit: plan.document_limit };
}

export function checkAutomationLimit(organizationId: string): LimitCheck {
  const plan = getEffectivePlan(organizationId);
  if (plan.automation_limit === 0) {
    return { allowed: false, reason: `Automations are not included in the ${plan.name} plan.` };
  }
  const row = get<{ c: number }>("select count(*) as c from automations where organization_id = ?", [organizationId]);
  const used = row?.c ?? 0;
  if (used >= plan.automation_limit) {
    return { allowed: false, reason: `Automation limit (${plan.automation_limit}) reached on the ${plan.name} plan.`, used, limit: plan.automation_limit };
  }
  return { allowed: true, used, limit: plan.automation_limit };
}

export function setPlanForOrg(organizationId: string, planCode: string, opts: {
  status?: string; stripeCustomerId?: string; stripeSubscriptionId?: string; billingCycle?: "monthly" | "annual";
} = {}) {
  const existing = get<{ id: string }>("select id from subscriptions where organization_id = ?", [organizationId]);
  const status = opts.status ?? "trialing";
  if (existing) {
    run(
      `update subscriptions set plan_code = ?, status = ?, stripe_customer_id = coalesce(?, stripe_customer_id),
        stripe_subscription_id = coalesce(?, stripe_subscription_id), billing_cycle = ?, updated_at = ?
        where organization_id = ?`,
      [planCode, status, opts.stripeCustomerId ?? null, opts.stripeSubscriptionId ?? null, opts.billingCycle ?? "monthly", nowIso(), organizationId]
    );
  } else {
    run(
      `insert into subscriptions (id, organization_id, plan_code, status, stripe_customer_id, stripe_subscription_id,
        billing_cycle, trial_ends_at, created_at, updated_at)
       values (?,?,?,?,?,?,?,?,?,?)`,
      [
        newId(), organizationId, planCode, status, opts.stripeCustomerId ?? null, opts.stripeSubscriptionId ?? null,
        opts.billingCycle ?? "monthly", null, nowIso(), nowIso(),
      ]
    );
  }
}
