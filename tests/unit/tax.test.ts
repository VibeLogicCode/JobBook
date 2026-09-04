import { describe, expect, it } from 'vitest';
import { computeLine } from '@/lib/quote/lines';
import { computeTaxes, selectRatesInForce, type TaxRateInput } from '@/lib/quote/tax';
import type { ComputedLine, LineInput } from '@/lib/quote/types';

function line(over: Partial<LineInput> = {}): ComputedLine {
  return computeLine({
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
  });
}

function rate(over: Partial<TaxRateInput> = {}): TaxRateInput {
  return {
    label: 'HST',
    registrationNumber: '123456789RT0001',
    rateTenThou: 1300n,
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    isCompound: false,
    sortOrder: 1,
    ...over,
  };
}

const ON = { onDate: '2025-06-01', customerExempt: false };
/** $1,000.00, taxable, included. */
const THOUSAND = line({ unitPriceTenThou: 10000000n });

describe('selectRatesInForce', () => {
  const oldRate = rate({ label: 'old', rateTenThou: 1500n, effectiveFrom: '2020-01-01', effectiveTo: '2025-03-31' });
  const newRate = rate({ label: 'new', rateTenThou: 1400n, effectiveFrom: '2025-04-01', effectiveTo: null });

  it('takes the rate in force before a change', () => {
    expect(selectRatesInForce([oldRate, newRate], '2025-03-15').map((r) => r.label)).toEqual(['old']);
  });

  it('treats effectiveFrom as inclusive on the changeover day', () => {
    expect(selectRatesInForce([oldRate, newRate], '2025-04-01').map((r) => r.label)).toEqual(['new']);
  });

  it('treats effectiveTo as inclusive on the last day', () => {
    expect(selectRatesInForce([oldRate, newRate], '2025-03-31').map((r) => r.label)).toEqual(['old']);
  });

  it('drops a rate that has not started', () => {
    const future = rate({ label: 'future', effectiveFrom: '2026-01-01' });
    expect(selectRatesInForce([future], '2025-06-01')).toEqual([]);
  });

  it('sorts by sortOrder, not input order', () => {
    const pst = rate({ label: 'PST', sortOrder: 2 });
    const gst = rate({ label: 'GST', sortOrder: 1 });
    expect(selectRatesInForce([pst, gst], '2025-06-01').map((r) => r.label)).toEqual(['GST', 'PST']);
  });

  it('does not mutate or reorder the caller array', () => {
    const pst = rate({ label: 'PST', sortOrder: 2 });
    const gst = rate({ label: 'GST', sortOrder: 1 });
    const input = [pst, gst];
    selectRatesInForce(input, '2025-06-01');
    expect(input.map((r) => r.label)).toEqual(['PST', 'GST']);
  });
});

describe('computeTaxes', () => {
  it('taxes a single rate on the whole base', () => {
    const big = line({ unitPriceTenThou: 843000000n });
    const [hst] = computeTaxes([big], [rate()], ON);
    expect(hst?.taxableBaseCents).toBe(8430000);
    expect(hst?.taxAmountCents).toBe(1095900);
    expect(hst?.label).toBe('HST');
    expect(hst?.registrationNumber).toBe('123456789RT0001');
    expect(hst?.rateTenThou).toBe(1300n);
  });

  it('rounds once on the summed base, not per line', () => {
    // Three $0.05 lines at 13%: 2 cents. Rounding per line gives 3, and across a
    // forty-line quote that drift is what makes the customer's own arithmetic
    // disagree with the printed document.
    const nickel = line({ unitPriceTenThou: 500n });
    const [hst] = computeTaxes([nickel, nickel, nickel], [rate()], ON);
    expect(hst?.taxableBaseCents).toBe(15);
    expect(hst?.taxAmountCents).toBe(2);
  });

  it('applies two independent rates to the same plain base', () => {
    const gst = rate({ label: 'GST', rateTenThou: 500n, sortOrder: 1 });
    const pst = rate({ label: 'PST', rateTenThou: 700n, sortOrder: 2 });
    const taxes = computeTaxes([THOUSAND], [gst, pst], ON);
    expect(taxes.map((t) => t.taxableBaseCents)).toEqual([100000, 100000]);
    expect(taxes.map((t) => t.taxAmountCents)).toEqual([5000, 7000]);
  });

  it('compounds a compound rate onto the base plus tax already accumulated', () => {
    const gst = rate({ label: 'GST', rateTenThou: 500n, sortOrder: 1 });
    const pst = rate({ label: 'PST', rateTenThou: 1000n, sortOrder: 2, isCompound: true });
    const taxes = computeTaxes([THOUSAND], [gst, pst], ON);
    expect(taxes[0]?.taxableBaseCents).toBe(100000);
    expect(taxes[0]?.taxAmountCents).toBe(5000);
    expect(taxes[1]?.taxableBaseCents).toBe(105000);
    expect(taxes[1]?.taxAmountCents).toBe(10500);
  });

  it('excludes non-taxable lines from the base', () => {
    const exemptLine = line({ unitPriceTenThou: 5000000n, isTaxable: false });
    const [hst] = computeTaxes([THOUSAND, exemptLine], [rate()], ON);
    expect(hst?.taxableBaseCents).toBe(100000);
  });

  it('excludes lines that are not included from the base', () => {
    const optional = line({ unitPriceTenThou: 5000000n, isOptional: true, isIncluded: false });
    const [hst] = computeTaxes([THOUSAND, optional], [rate()], ON);
    expect(hst?.taxableBaseCents).toBe(100000);
  });

  it('reduces the base by a discount line', () => {
    const discount = line({ unitPriceTenThou: -2500000n });
    const [hst] = computeTaxes([THOUSAND, discount], [rate()], ON);
    expect(hst?.taxableBaseCents).toBe(75000);
    expect(hst?.taxAmountCents).toBe(9750);
  });

  it('uses the rate in force on the given date', () => {
    const oldRate = rate({ rateTenThou: 1500n, effectiveFrom: '2020-01-01', effectiveTo: '2025-03-31' });
    const newRate = rate({ rateTenThou: 1400n, effectiveFrom: '2025-04-01' });
    const before = computeTaxes([THOUSAND], [oldRate, newRate], { ...ON, onDate: '2025-03-15' });
    const after = computeTaxes([THOUSAND], [oldRate, newRate], { ...ON, onDate: '2025-04-01' });
    expect(before.map((t) => t.taxAmountCents)).toEqual([15000]);
    expect(after.map((t) => t.taxAmountCents)).toEqual([14000]);
  });

  it('skips a rate that has not started', () => {
    const future = rate({ effectiveFrom: '2026-01-01' });
    expect(computeTaxes([THOUSAND], [future], ON)).toEqual([]);
  });

  it('orders output by sortOrder', () => {
    const pst = rate({ label: 'PST', rateTenThou: 700n, sortOrder: 2 });
    const gst = rate({ label: 'GST', rateTenThou: 500n, sortOrder: 1 });
    expect(computeTaxes([THOUSAND], [pst, gst], ON).map((t) => t.label)).toEqual(['GST', 'PST']);
  });

  it('returns nothing for an exempt customer', () => {
    expect(computeTaxes([THOUSAND], [rate()], { ...ON, customerExempt: true })).toEqual([]);
  });

  it('returns a zero base rather than nothing when no line is taxable', () => {
    const exemptLine = line({ unitPriceTenThou: 5000000n, isTaxable: false });
    const [hst] = computeTaxes([exemptLine], [rate()], ON);
    expect(hst?.taxableBaseCents).toBe(0);
    expect(hst?.taxAmountCents).toBe(0);
  });

  it('returns an empty array when there are no rates', () => {
    expect(computeTaxes([THOUSAND], [], ON)).toEqual([]);
  });
});
