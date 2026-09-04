import { describe, expect, it } from 'vitest';
import { computeLine } from '@/lib/quote/lines';
import type { CalcMode, LineInput } from '@/lib/quote/types';

function line(over: Partial<LineInput> = {}): LineInput {
  return {
    code: 'L1',
    description: 'a line',
    lineGroup: 'General',
    sortOrder: 1,
    calcMode: 'qty' as CalcMode,
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

describe('computeLine qty', () => {
  it('multiplies quantity by both rates', () => {
    const result = computeLine(
      line({ qtyMilli: 1240500n, unitCostTenThou: 30000n, unitPriceTenThou: 40000n }),
    );
    expect(result.lineCostCents).toBe(372150);
    expect(result.lineTotalCents).toBe(496200);
  });

  it('rounds a half-cent away from zero', () => {
    const result = computeLine(line({ qtyMilli: 1000n, unitPriceTenThou: 50n }));
    expect(result.lineTotalCents).toBe(1);
  });

  it('returns zero for a zero quantity', () => {
    const result = computeLine(line({ qtyMilli: 0n, unitPriceTenThou: 40000n }));
    expect(result.lineTotalCents).toBe(0);
  });
});

describe('computeLine flat', () => {
  it('charges the rate once', () => {
    const result = computeLine(
      line({ calcMode: 'flat', unitCostTenThou: 6000000n, unitPriceTenThou: 7500000n }),
    );
    expect(result.lineCostCents).toBe(60000);
    expect(result.lineTotalCents).toBe(75000);
  });

  it('ignores a stray quantity so a permit fee cannot be multiplied', () => {
    const withQty = computeLine(
      line({ calcMode: 'flat', qtyMilli: 9000n, unitPriceTenThou: 7500000n }),
    );
    const withoutQty = computeLine(
      line({ calcMode: 'flat', qtyMilli: 0n, unitPriceTenThou: 7500000n }),
    );
    expect(withQty.lineTotalCents).toBe(75000);
    expect(withoutQty.lineTotalCents).toBe(75000);
  });
});

describe('computeLine percent', () => {
  it('returns zero, deferring to the subtotal it cannot see', () => {
    const result = computeLine(
      line({ calcMode: 'percent', qtyMilli: 5000n, unitCostTenThou: 1000n, unitPriceTenThou: 1500n }),
    );
    expect(result.lineCostCents).toBe(0);
    expect(result.lineTotalCents).toBe(0);
    expect(result.displayPriceCents).toBe(0);
  });
});

describe('computeLine negative rates', () => {
  it('produces a negative total for a discount line', () => {
    const result = computeLine(
      line({ calcMode: 'flat', unitCostTenThou: 0n, unitPriceTenThou: -2500000n }),
    );
    expect(result.lineTotalCents).toBe(-25000);
  });

  it('produces a negative total for a deductive quantity line', () => {
    const result = computeLine(
      line({ qtyMilli: 2000n, unitCostTenThou: -30000n, unitPriceTenThou: -40000n }),
    );
    expect(result.lineCostCents).toBe(-600);
    expect(result.lineTotalCents).toBe(-800);
  });
});

describe('computeLine passthrough', () => {
  it('sets displayPriceCents to the line total at this stage', () => {
    const result = computeLine(line({ qtyMilli: 2000n, unitPriceTenThou: 40000n, isIncluded: false }));
    expect(result.displayPriceCents).toBe(result.lineTotalCents);
    expect(result.displayPriceCents).toBe(800);
  });

  it('carries every input field through untouched', () => {
    const input = line({
      code: 'FRM-01',
      unitLabel: 'lnft',
      isAllowance: true,
      isOptional: true,
      isIncluded: false,
      isTaxable: false,
      rateItemId: 'rate-7',
      costCodeId: 'cc-3',
    });
    const result = computeLine(input);
    expect(result.code).toBe('FRM-01');
    expect(result.unitLabel).toBe('lnft');
    expect(result.isAllowance).toBe(true);
    expect(result.isOptional).toBe(true);
    expect(result.isIncluded).toBe(false);
    expect(result.isTaxable).toBe(false);
    expect(result.rateItemId).toBe('rate-7');
    expect(result.costCodeId).toBe('cc-3');
  });

  it('does not mutate its input', () => {
    const input = line({ qtyMilli: 2000n, unitPriceTenThou: 40000n });
    computeLine(input);
    expect(Object.hasOwn(input, 'lineTotalCents')).toBe(false);
  });
});
