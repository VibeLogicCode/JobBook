import { marginBasisPoints } from '@/lib/money/scale';
import { applyPercentLines } from '@/lib/quote/percent';
import { computeTaxes, type ComputedTax, type TaxRateInput } from '@/lib/quote/tax';
import type { ComputedLine, LineInput } from '@/lib/quote/types';

export interface QuoteTotals {
  lines: ComputedLine[];
  taxes: ComputedTax[];
  subtotalCents: number;
  taxTotalCents: number;
  totalCents: number;
  totalCostCents: number;
  marginBp: number;
  /**
   * Sum of the excluded optional lines at the price the document prints, which
   * is their grossed-up price. Summing raw line totals here would print an
   * upgrades total that disagrees with the upgrade lines above it.
   */
  optionalTotalCents: number;
}

/**
 * The single entry point for pricing a quote.
 *
 * Pure: reads nothing, writes nothing, so it is cheap to test exhaustively and
 * cannot become order-dependent on database state. Callers persist the result;
 * they never recompute a stored quote's total against current rates.
 */
export function computeQuote(
  lines: LineInput[],
  rates: TaxRateInput[],
  opts: { onDate: string; customerExempt: boolean },
): QuoteTotals {
  const computed = applyPercentLines(lines);

  let subtotalCents = 0;
  let totalCostCents = 0;
  let optionalTotalCents = 0;
  for (const line of computed) {
    if (line.isIncluded) {
      subtotalCents += line.lineTotalCents;
      totalCostCents += line.lineCostCents;
    } else {
      optionalTotalCents += line.displayPriceCents;
    }
  }

  const taxes = computeTaxes(computed, rates, opts);
  const taxTotalCents = taxes.reduce((sum, tax) => sum + tax.taxAmountCents, 0);

  return {
    lines: computed,
    taxes,
    subtotalCents,
    taxTotalCents,
    totalCents: subtotalCents + taxTotalCents,
    totalCostCents,
    // Margin, not markup: on price. A 25% margin is a 33% markup, and quoting
    // one while thinking of the other is how a job loses money on paper.
    marginBp: marginBasisPoints(BigInt(subtotalCents), BigInt(totalCostCents)),
    optionalTotalCents,
  };
}
