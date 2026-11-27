/**
 * Plan limits, and the one workspace that has none.
 *
 * The platform owner's own workspace is deliberately unlimited: making the vendor
 * pay themselves (or approve their own payment) to use the product they are selling
 * is theatre, and a self-approval path that *also* has to satisfy the plan engine is
 * how a demo gets blocked halfway through by a "you have used all 250 leads" banner.
 *
 * The rule lives here — in the limit layer — rather than in the UI, so every caller
 * (`checkLeadLimit`, `checkAiLimit`, seat checks in invites, `checkFeature`, …) gets
 * the same answer. Hiding a button was never the enforcement.
 *
 * `Infinity` is used rather than a big number on purpose: `used >= Infinity` is
 * always false, so an arithmetic comparison cannot accidentally exceed it, and no
 * future caller has to know a magic constant.
 */

export const UNLIMITED = Number.POSITIVE_INFINITY;

/** True for the unlimited sentinel (and for any "pretend to be huge" value). */
export function isUnlimited(limit: number | null | undefined): boolean {
  if (typeof limit !== "number") return false;
  return !Number.isFinite(limit) || limit >= Number.MAX_SAFE_INTEGER;
}

/** "Unlimited" instead of "∞" or 9007199254740991 in the UI. */
export function limitLabel(limit: number | null | undefined): string {
  if (isUnlimited(limit)) return "Unlimited";
  return Number(limit ?? 0).toLocaleString();
}

/** Usage out of a limit, in the shape the pages print. */
export function usageLabel(used: number, limit: number | null | undefined): string {
  return `${used.toLocaleString()} / ${limitLabel(limit)}`;
}
