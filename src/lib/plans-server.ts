import { isStripeConfigured, stripePriceId } from "./stripe";
export { listPlans, getEffectivePlan, checkLeadLimit, checkAiLimit, checkFeature, checkDocumentLimit, checkAutomationLimit, recordUsage, usageThisMonth, leadCount, setPlanForOrg, subscriptionIsUsable, DEFAULT_PLAN_CODE } from "./plans";
export type { EffectivePlan, PlanFeatures } from "./plans";

/**
 * True only when both the Stripe secret key and every plan's price ID exist.
 * The UI uses this to decide whether to *offer* checkout — it never assumes success.
 */
export function isStripeDeploymentReady(): boolean {
  if (!isStripeConfigured()) return false;
  return ["starter", "professional", "business", "agency"].every((code) => Boolean(stripePriceId(code, "monthly")));
}
