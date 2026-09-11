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

/**
 * A line already on a quote, as the send guard sees it.
 *
 * Its OWN price, not the rate item's: `quote_lines.unit_price_ten_thou` is
 * snapshotted at expansion, so a rate priced after the quote was built does
 * not retroactively price the quote -- which is the whole point of the
 * snapshot, and the reason this cannot be answered by re-reading `rate_items`.
 */
export interface PriceableLine {
  code: string;
  calcMode: CalcMode;
  unitPriceTenThou: bigint;
  isAllowance: boolean;
}

/**
 * The codes still needing a price, in the order they appear.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AS WELL AS `unpricedProblem`
 * ---------------------------------------------------------------------------
 *
 * `unpricedProblem` guards ONE path: adding a line to a quote by hand. It is
 * the only enforcement in the product, and a trade pack's scope template does
 * not go through it -- `createQuoteFromTemplate` expands whatever the template
 * names, so a starter template of deliberately unpriced items produces a draft
 * full of zero-priced lines.
 *
 * Which is fine, and is arguably the most useful screen in a first hour: it
 * shows exactly which prices the owner has to put in. What is NOT fine is that
 * draft being sent. Under `pricingDisplay`'s `group_totals` default a
 * zero-priced line does not print at all, so the customer receives a document
 * that silently omits the price of real work, and the first person to notice
 * is whoever reconciles the invoice.
 *
 * So: the template may build it, the worksheet says what is missing, and
 * sending is refused until it is filled in. Nobody has to know that a zero in
 * a rate column means "not done yet" -- which is exactly the kind of thing an
 * owner with no IT support should never have to work out from a silent
 * document.
 *
 * OPTIONAL lines are checked too, `isIncluded` being deliberately absent from
 * the interface. An optional line is an upgrade the customer is invited to
 * choose, it prints with a price beside it, and one priced at nothing is the
 * same broken document.
 */
export function unpricedLineCodes(lines: readonly PriceableLine[]): string[] {
  return lines
    .filter((line) =>
      unpricedProblem({
        code: line.code,
        calcMode: line.calcMode,
        sellRateTenThou: line.unitPriceTenThou,
        isAllowance: line.isAllowance,
      }) !== null,
    )
    .map((line) => line.code);
}

/**
 * The refusal for a quote that cannot go out yet, or null.
 *
 * Names the codes rather than counting them, because "3 lines need a price" is
 * not something anybody can act on without going hunting.
 */
export function unsendableProblem(lines: readonly PriceableLine[]): string | null {
  const codes = unpricedLineCodes(lines);
  if (codes.length === 0) return null;

  const named = codes.length <= 6 ? codes.join(', ') : `${codes.slice(0, 6).join(', ')} and ${codes.length - 6} more`;
  const subject = codes.length === 1 ? 'One line has' : `${codes.length} lines have`;

  return (
    `${subject} no price yet: ${named}. A line priced at nothing does not print on the ` +
    "customer's copy at all, so sending this would send a quote with real work silently " +
    'missing from it. Put a price on each one, or mark it as an allowance if the amount is ' +
    'genuinely not known yet.'
  );
}
