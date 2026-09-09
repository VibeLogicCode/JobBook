import type { CalcMode } from '@/lib/quote/types';

/**
 * Whether a rate item may go on a quote at all, given what it is priced at.
 *
 * ---------------------------------------------------------------------------
 * WHY A ZERO PRICE IS REFUSED AND A NEGATIVE ONE IS NOT
 * ---------------------------------------------------------------------------
 *
 * `rate_items.sell_rate_ten_thou` is NOT NULL, so "not priced yet" and
 * "priced at nothing" are the same row. That was harmless while every rate was
 * typed by the owner. It stops being harmless the moment a trade starter pack
 * ships a hundred items with codes, descriptions and no prices -- which is
 * exactly what `2026-09-09-service-and-contract-work-design.md` §5.3 requires,
 * because shipping invented prices is worse.
 *
 * A zero-priced line is invisible rather than obviously wrong:
 *
 * - it contributes nothing to the subtotal;
 * - `marginBasisPoints` returns 0 on zero revenue, so the gauge reads like a
 *   badly-priced job rather than a broken one;
 * - `pricingDisplay` defaults to `group_totals`, under which the line does not
 *   print AT ALL.
 *
 * So the customer receives a document that silently omits the price of real
 * work, and the first person to notice is whoever reconciles the invoice. That
 * is the same failure class as the holdback paragraph printing on a job that
 * withheld nothing: correct arithmetic over a row nobody refused.
 *
 * A NEGATIVE price is permitted, because `rate_items` says what it is for in
 * as many words -- *"May be negative: a discount line, or a deductive change
 * order."* Refusing it to catch zeros would break a feature to guard a
 * mistake.
 *
 * ---------------------------------------------------------------------------
 * THE TWO EXEMPTIONS
 * ---------------------------------------------------------------------------
 *
 * `percent` mode: the rate IS the percentage, so zero means "no uplift", which
 * is a thing somebody may legitimately want stated on a quote.
 *
 * An allowance: a placeholder the customer spends against and which is
 * reconciled against actual cost later. Nothing about it requires a figure at
 * the moment it is added.
 */

export interface PriceableItem {
  /** Named in the refusal, because "an item" is not something to go and fix. */
  code: string;
  calcMode: CalcMode;
  sellRateTenThou: bigint;
  isAllowance: boolean;
}

/** The refusal sentence, or null to allow the line. */
export function unpricedProblem(item: PriceableItem): string | null {
  if (item.sellRateTenThou !== 0n) return null;
  if (item.calcMode === 'percent') return null;
  if (item.isAllowance) return null;

  return (
    `${item.code} has no sell price, so it would add nothing to this quote and would not ` +
    `print on it at all — the customer would get a document missing the price of real work. ` +
    `Set a rate for ${item.code} on the Rates screen first, or mark it an allowance if the ` +
    `figure genuinely is not known yet.`
  );
}
