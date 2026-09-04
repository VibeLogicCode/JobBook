import { QTY_SCALE, lineTotalCents } from '@/lib/money/scale';
import type { ComputedLine, LineInput } from '@/lib/quote/types';

/**
 * Price and cost one line in isolation.
 *
 * Returns a new object rather than mutating: a quote is recomputed on every
 * keystroke, and a caller that holds the original inputs must be able to trust
 * they still say what the user typed.
 */
export function computeLine(line: LineInput): ComputedLine {
  const { costCents, totalCents } = amounts(line);
  return {
    ...line,
    lineCostCents: costCents,
    lineTotalCents: totalCents,
    // Corrected for excluded lines in percent.ts, which can see the whole quote.
    displayPriceCents: totalCents,
  };
}

function amounts(line: LineInput): { costCents: number; totalCents: number } {
  switch (line.calcMode) {
    case 'qty':
      return {
        costCents: Number(lineTotalCents(line.qtyMilli, line.unitCostTenThou)),
        totalCents: Number(lineTotalCents(line.qtyMilli, line.unitPriceTenThou)),
      };
    case 'flat':
      // A quantity of exactly one, so a stray qtyMilli left on a permit fee or a
      // dumpster charge cannot silently multiply it.
      return {
        costCents: Number(lineTotalCents(QTY_SCALE, line.unitCostTenThou)),
        totalCents: Number(lineTotalCents(QTY_SCALE, line.unitPriceTenThou)),
      };
    case 'percent':
      // Zero rather than a throw: a percent line's value depends on a subtotal
      // this function cannot see, and returning zero lets a caller compute a
      // mixed list in one pass before percent.ts resolves it.
      return { costCents: 0, totalCents: 0 };
  }
}
