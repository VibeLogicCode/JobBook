import { describe, expect, it } from 'vitest';
import { applyPercentLines } from '@/lib/quote/percent';
import type { LineInput } from '@/lib/quote/types';

function line(over: Partial<LineInput> = {}): LineInput {
  return {
    code: 'L1',
    description: 'a line',
    lineGroup: 'General',
    sortOrder: 1,
    calcMode: 'flat',
    unitLabel: 'ea',
    qtyMilli: 1000n,
    unitCostTenThou: 0n,
    unitPriceTenThou: 0n,
    isTaxable: true,
    isOptional: false,
    isIncluded: true,
    isAllowance: false,
    rateItemId: null,
    costCodeId: null,
    ...over,
  };
}

/** $1,000.00 flat, included. */
const A = line({ code: 'A', unitCostTenThou: 6000000n, unitPriceTenThou: 10000000n });
/** 10% overhead, included. */
const OH = line({ code: 'OH', calcMode: 'percent', unitCostTenThou: 1000n, unitPriceTenThou: 1000n });
/** $500.00 flat upgrade, excluded. */
const OPT = line({
  code: 'OPT',
  unitPriceTenThou: 5000000n,
  unitCostTenThou: 4000000n,
  isOptional: true,
  isIncluded: false,
});

const byCode = (lines: ReturnType<typeof applyPercentLines>, code: string) => {
  const found = lines.find((l) => l.code === code);
  if (!found) throw new Error(`no line ${code}`);
  return found;
};

describe('applyPercentLines base', () => {
  it('prices a percent line off the included non-percent lines', () => {
    const result = applyPercentLines([A, OH]);
    expect(byCode(result, 'OH').lineTotalCents).toBe(10000);
    expect(byCode(result, 'OH').lineCostCents).toBe(6000);
  });

  it('excludes excluded lines from the base', () => {
    const result = applyPercentLines([A, OH, OPT]);
    expect(byCode(result, 'OH').lineTotalCents).toBe(10000);
  });

  it('never compounds one percent line onto another', () => {
    const profit = line({ code: 'PR', calcMode: 'percent', unitPriceTenThou: 1500n });
    const result = applyPercentLines([A, OH, profit]);
    // 15% of $1,000, not 15% of ($1,000 + $100).
    expect(byCode(result, 'PR').lineTotalCents).toBe(15000);
    expect(byCode(result, 'OH').lineTotalCents).toBe(10000);
  });

  it('gives the same answer whichever order the percent lines appear in', () => {
    const profit = line({ code: 'PR', calcMode: 'percent', unitPriceTenThou: 1500n });
    const forward = applyPercentLines([A, OH, profit]);
    const reversed = applyPercentLines([A, profit, OH]);
    expect(byCode(forward, 'OH').lineTotalCents).toBe(byCode(reversed, 'OH').lineTotalCents);
    expect(byCode(forward, 'PR').lineTotalCents).toBe(byCode(reversed, 'PR').lineTotalCents);
  });

  it('applies a negative percent as a reduction', () => {
    const rebate = line({ code: 'RB', calcMode: 'percent', unitPriceTenThou: -500n });
    const result = applyPercentLines([A, rebate]);
    expect(byCode(result, 'RB').lineTotalCents).toBe(-5000);
  });

  it('prices a percent line at zero when nothing is included', () => {
    const result = applyPercentLines([{ ...A, isIncluded: false }, OH]);
    expect(byCode(result, 'OH').lineTotalCents).toBe(0);
  });

  it('preserves input order', () => {
    const result = applyPercentLines([OH, OPT, A]);
    expect(result.map((l) => l.code)).toEqual(['OH', 'OPT', 'A']);
  });

  it('returns an empty array for an empty quote', () => {
    expect(applyPercentLines([])).toEqual([]);
  });
});

describe('applyPercentLines displayPriceCents', () => {
  it('grosses an excluded line up by the percent lines it would attract', () => {
    const result = applyPercentLines([A, OH, OPT]);
    // Printing $500 and invoicing $550 is a customer-facing correctness bug.
    expect(byCode(result, 'OPT').displayPriceCents).toBe(55000);
    expect(byCode(result, 'OPT').lineTotalCents).toBe(50000);
  });

  it('makes the grossed-up figure match the real change on acceptance', () => {
    const base = applyPercentLines([A, OH, OPT]);
    const accepted = applyPercentLines([A, OH, { ...OPT, isIncluded: true }]);
    const subtotal = (lines: typeof base) =>
      lines.filter((l) => l.isIncluded).reduce((sum, l) => sum + l.lineTotalCents, 0);
    expect(subtotal(base)).toBe(110000);
    expect(subtotal(accepted)).toBe(165000);
    expect(subtotal(accepted) - subtotal(base)).toBe(byCode(base, 'OPT').displayPriceCents);
  });

  it('leaves displayPriceCents equal to lineTotalCents for included lines', () => {
    const result = applyPercentLines([A, OH, OPT]);
    expect(byCode(result, 'A').displayPriceCents).toBe(byCode(result, 'A').lineTotalCents);
    expect(byCode(result, 'OH').displayPriceCents).toBe(byCode(result, 'OH').lineTotalCents);
  });

  it('sums the gross-up across several included percent lines', () => {
    const profit = line({ code: 'PR', calcMode: 'percent', unitPriceTenThou: 1500n });
    const result = applyPercentLines([A, OH, profit, OPT]);
    // $500 + 10% + 15%, each rounded on its own.
    expect(byCode(result, 'OPT').displayPriceCents).toBe(50000 + 5000 + 7500);
  });

  it('ignores an excluded percent line when grossing up', () => {
    const dormant = line({
      code: 'DM',
      calcMode: 'percent',
      unitPriceTenThou: 2000n,
      isOptional: true,
      isIncluded: false,
    });
    const result = applyPercentLines([A, OH, dormant, OPT]);
    expect(byCode(result, 'OPT').displayPriceCents).toBe(55000);
  });

  it('grosses a negative excluded line down, keeping a deduction reversible', () => {
    const credit = line({
      code: 'CR',
      unitPriceTenThou: -5000000n,
      isOptional: true,
      isIncluded: false,
    });
    const result = applyPercentLines([A, OH, credit]);
    expect(byCode(result, 'CR').displayPriceCents).toBe(-55000);
  });

  it('does not gross up an excluded percent line, which cannot compound', () => {
    const dormant = line({
      code: 'DM',
      calcMode: 'percent',
      unitPriceTenThou: 2000n,
      isOptional: true,
      isIncluded: false,
    });
    const result = applyPercentLines([A, OH, dormant]);
    expect(byCode(result, 'DM').lineTotalCents).toBe(20000);
    expect(byCode(result, 'DM').displayPriceCents).toBe(20000);
  });
});
