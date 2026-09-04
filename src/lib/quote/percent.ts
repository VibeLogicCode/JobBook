import { applyPercentCents } from '@/lib/money/scale';
import { computeLine } from '@/lib/quote/lines';
import type { ComputedLine, LineInput } from '@/lib/quote/types';

/**
 * Compute a whole line list, resolving percent lines against the base they
 * apply to and grossing up the price shown for excluded options.
 */
export function applyPercentLines(lines: LineInput[]): ComputedLine[] {
  const computed = lines.map(computeLine);

  // Every percent line reads the same base. Overhead at 10% and profit at 15%
  // both apply to the included work, never 15% of (work + overhead) -- otherwise
  // the customer's total would depend on the order the lines happen to sit in.
  let baseCents = 0n;
  let costBaseCents = 0n;
  for (const line of computed) {
    if (line.calcMode === 'percent' || !line.isIncluded) continue;
    baseCents += BigInt(line.lineTotalCents);
    costBaseCents += BigInt(line.lineCostCents);
  }

  for (const line of computed) {
    if (line.calcMode !== 'percent') continue;
    line.lineCostCents = Number(applyPercentCents(costBaseCents, line.unitCostTenThou));
    line.lineTotalCents = Number(applyPercentCents(baseCents, line.unitPriceTenThou));
    line.displayPriceCents = line.lineTotalCents;
  }

  // Percent lines apply only to included work, so accepting a $500 upgrade under
  // 10% overhead actually raises the quote by $550. Printing $500 and then
  // invoicing $550 is the bug this exists to prevent.
  const activeRates = computed
    .filter((line) => line.calcMode === 'percent' && line.isIncluded)
    .map((line) => line.unitPriceTenThou);

  for (const line of computed) {
    // A percent line grossed up by other percent lines would be exactly the
    // compounding ruled out above, so it is left at its own value.
    if (line.isIncluded || line.calcMode === 'percent') continue;
    const total = BigInt(line.lineTotalCents);
    let display = total;
    for (const rate of activeRates) display += applyPercentCents(total, rate);
    line.displayPriceCents = Number(display);
  }

  return computed;
}
