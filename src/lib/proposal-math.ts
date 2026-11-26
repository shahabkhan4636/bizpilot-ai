/**
 * Proposal arithmetic — pure functions, no I/O.
 *
 * Kept out of the server-action module (which may only export async functions)
 * so the money can be unit-tested and reused by the PDF renderer.
 *
 * Order of operations, the only order that matches how a client reads an
 * invoice: subtotal → discount → taxable base → tax → total. A discount can
 * never push the total negative, and percentages are clamped to 0–100.
 */

export type DiscountInput = { percent?: number; cents?: number };

export type ProposalTotals = {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  taxable: number;
};

export function computeTotals(
  items: { amount_cents: number }[],
  taxPercent: number,
  discount: DiscountInput = {}
): ProposalTotals {
  const subtotal = items.reduce((sum, i) => sum + Math.round(i.amount_cents), 0);

  const percent = Math.min(100, Math.max(0, Number(discount.percent ?? 0)));
  const fixed = Math.max(0, Math.round(Number(discount.cents ?? 0)));
  const percentCut = Math.round((subtotal * percent) / 100);
  const discountCents = Math.min(subtotal, percentCut + fixed);

  const taxable = subtotal - discountCents;
  const taxPercentClamped = Math.min(100, Math.max(0, Number(taxPercent) || 0));
  const tax = Math.round((taxable * taxPercentClamped) / 100);
  const total = Math.max(0, taxable + tax);

  return { subtotal, discount: discountCents, tax, total, taxable };
}
