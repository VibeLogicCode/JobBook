import { describe, expect, it } from 'vitest';
import type { TaxRateInput } from '@/lib/quote/tax';
import { computeQuote } from '@/lib/quote/totals';
import type { LineInput } from '@/lib/quote/types';

const hst: TaxRateInput = {
  label: 'HST',
  registrationNumber: null,
  rateTenThou: 1300n,
  effectiveFrom: '2010-07-01',
  effectiveTo: null,
  isCompound: false,
  sortOrder: 1,
};

const ON = { onDate: '2026-09-01', customerExempt: false };

function line(overrides: Partial<LineInput> = {}): LineInput {
  return {
    code: 'X',
    description: 'X',
    lineGroup: 'G',
    sortOrder: 1,
    calcMode: 'flat',
    unitLabel: '',
    qtyMilli: 1000n,
    unitCostTenThou: 0n,
    unitPriceTenThou: 0n,
    isTaxable: true,
    isOptional: false,
    isIncluded: true,
    isAllowance: false,
    rateItemId: null,
    costCodeId: null,
    ...overrides,
  };
}

describe('computeQuote', () => {
  it('assembles subtotal, tax, and total', () => {
    const result = computeQuote(
      [line({ unitPriceTenThou: 10000000n, unitCostTenThou: 7500000n })],
      [hst],
      ON,
    );
    expect(result.subtotalCents).toBe(100000);
    expect(result.taxTotalCents).toBe(13000);
    expect(result.totalCents).toBe(113000);
    expect(result.totalCostCents).toBe(75000);
    expect(result.marginBp).toBe(2500);
  });

  it('keeps optional lines out of the subtotal and reports them separately', () => {
    const result = computeQuote(
      [
        line({ unitPriceTenThou: 10000000n }),
        line({ code: 'OPT', sortOrder: 2, unitPriceTenThou: 4200000n, isOptional: true, isIncluded: false }),
      ],
      [hst],
      ON,
    );
    expect(result.subtotalCents).toBe(100000);
    expect(result.optionalTotalCents).toBe(42000);
  });

  it('reports optional lines at the price the document prints', () => {
    // The $420 upgrade attracts the 10% overhead once accepted, so the printed
    // line reads $462 and the "available upgrades" total must agree with it.
    const result = computeQuote(
      [
        line({ unitPriceTenThou: 10000000n }),
        line({ code: 'OH', sortOrder: 2, calcMode: 'percent', unitLabel: '%', unitPriceTenThou: 1000n }),
        line({ code: 'OPT', sortOrder: 3, unitPriceTenThou: 4200000n, isOptional: true, isIncluded: false }),
      ],
      [hst],
      ON,
    );
    expect(result.subtotalCents).toBe(110000);
    expect(result.optionalTotalCents).toBe(46200);
  });

  it('includes percent lines in the subtotal', () => {
    const result = computeQuote(
      [
        line({ unitPriceTenThou: 10000000n, unitCostTenThou: 8000000n }),
        line({ code: 'OH', sortOrder: 2, calcMode: 'percent', unitLabel: '%', unitPriceTenThou: 1000n, unitCostTenThou: 0n }),
      ],
      [hst],
      ON,
    );
    expect(result.subtotalCents).toBe(110000);
    expect(result.totalCostCents).toBe(80000);
  });

  it('taxes the subtotal including percent lines, once', () => {
    const result = computeQuote(
      [
        line({ unitPriceTenThou: 10000000n }),
        line({ code: 'OH', sortOrder: 2, calcMode: 'percent', unitLabel: '%', unitPriceTenThou: 1000n }),
      ],
      [hst],
      ON,
    );
    expect(result.taxTotalCents).toBe(14300);
    expect(result.totalCents).toBe(124300);
  });

  it('excludes a non-taxable line from tax but not from the subtotal', () => {
    const result = computeQuote(
      [
        line({ unitPriceTenThou: 10000000n }),
        line({ code: 'NT', sortOrder: 2, unitPriceTenThou: 5000000n, isTaxable: false }),
      ],
      [hst],
      ON,
    );
    expect(result.subtotalCents).toBe(150000);
    expect(result.taxTotalCents).toBe(13000);
    expect(result.totalCents).toBe(163000);
  });

  it('produces a total equal to subtotal when the customer is exempt', () => {
    const result = computeQuote([line({ unitPriceTenThou: 10000000n })], [hst], {
      ...ON,
      customerExempt: true,
    });
    expect(result.taxes).toEqual([]);
    expect(result.totalCents).toBe(result.subtotalCents);
  });

  it('reports a negative margin when cost exceeds price', () => {
    const result = computeQuote(
      [line({ unitPriceTenThou: 10000000n, unitCostTenThou: 12000000n })],
      [hst],
      ON,
    );
    expect(result.marginBp).toBe(-2000);
  });

  it('returns zeroes for an empty quote without dividing by zero', () => {
    const result = computeQuote([], [hst], ON);
    expect(result.subtotalCents).toBe(0);
    expect(result.totalCents).toBe(0);
    expect(result.marginBp).toBe(0);
  });

  it('does not mutate the caller lines', () => {
    const input = [line({ unitPriceTenThou: 10000000n })];
    const snapshot = JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    computeQuote(input, [hst], ON);
    expect(JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(snapshot);
    expect('lineTotalCents' in input[0]!).toBe(false);
  });
});
