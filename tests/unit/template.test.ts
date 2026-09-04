import { describe, expect, it } from 'vitest';
import { expandTemplate, type ScopeInputs, type TemplateItem } from '@/lib/quote/template';

const inputs: ScopeInputs = {
  areaSqftMilli: 1240500n,
  washroomCount: 1,
  kitchenCount: 0,
  bedroomCount: 2,
};

function item(overrides: Partial<TemplateItem> = {}): TemplateItem {
  return {
    code: 'DEM-01',
    description: 'Strip existing',
    lineGroup: 'Demolition',
    sortOrder: 1,
    calcMode: 'qty',
    unitLabel: 'sqft',
    qtySource: 'area',
    qtyMultiplierTenThou: 10000n,
    fixedQtyMilli: null,
    costRateTenThou: 28000n,
    sellRateTenThou: 40000n,
    isTaxable: true,
    isOptional: false,
    isAllowance: false,
    rateItemId: 'rate-1',
    costCodeId: 'cost-1',
    ...overrides,
  };
}

describe('expandTemplate', () => {
  it('takes the area straight through at a multiplier of one', () => {
    const [line] = expandTemplate([item()], inputs);
    expect(line?.qtyMilli).toBe(1240500n);
  });

  it('scales the area by the multiplier', () => {
    // One pot light per 50 sqft is a multiplier of 0.02.
    const [line] = expandTemplate([item({ qtySource: 'area', qtyMultiplierTenThou: 200n })], inputs);
    expect(line?.qtyMilli).toBe(24810n); // 1240.5 x 0.02 = 24.81
  });

  it('reads a room count as a whole quantity', () => {
    const [line] = expandTemplate([item({ qtySource: 'washrooms', unitLabel: 'ea' })], inputs);
    expect(line?.qtyMilli).toBe(1000n);
  });

  it('uses the fixed quantity when the source is fixed', () => {
    const [line] = expandTemplate([item({ qtySource: 'fixed', fixedQtyMilli: 2000n, unitLabel: 'ea' })], inputs);
    expect(line?.qtyMilli).toBe(2000n);
  });

  it('emits a manual line at zero for the owner to fill in', () => {
    const [line] = expandTemplate([item({ qtySource: 'manual', unitLabel: 'hr' })], inputs);
    expect(line?.qtyMilli).toBe(0n);
  });

  it('drops a line whose derived quantity is zero, except manual ones', () => {
    const lines = expandTemplate(
      [
        item({ code: 'KIT-01', qtySource: 'kitchens', unitLabel: 'ea' }),
        item({ code: 'TM-01', qtySource: 'manual', unitLabel: 'hr', sortOrder: 2 }),
      ],
      inputs,
    );
    expect(lines.map((l) => l.code)).toEqual(['TM-01']);
  });

  it('keeps a flat line whose quantity is irrelevant', () => {
    // A permit fee prices the same whether the basement is 800 sqft or 1,600,
    // so it carries no quantity and must not be dropped for lacking one.
    const lines = expandTemplate(
      [item({ code: 'PRM-01', calcMode: 'flat', unitLabel: '', qtySource: 'fixed', fixedQtyMilli: null })],
      inputs,
    );
    expect(lines.map((l) => l.code)).toEqual(['PRM-01']);
  });

  it('keeps a percent line whose quantity is irrelevant', () => {
    const lines = expandTemplate(
      [item({ code: 'OH', calcMode: 'percent', unitLabel: '%', qtySource: 'fixed', fixedQtyMilli: null, sellRateTenThou: 1000n })],
      inputs,
    );
    expect(lines.map((l) => l.code)).toEqual(['OH']);
  });

  it('marks optional template items as excluded so they price as upgrades', () => {
    const [line] = expandTemplate([item({ isOptional: true })], inputs);
    expect(line?.isOptional).toBe(true);
    expect(line?.isIncluded).toBe(false);
  });

  it('rounds a derived quantity half up to thousandths', () => {
    // 1240.5 x 0.0005 = 0.62025 -> 0.620
    const [line] = expandTemplate([item({ qtyMultiplierTenThou: 5n })], inputs);
    expect(line?.qtyMilli).toBe(620n);
  });

  it('snapshots the template rates onto the line', () => {
    const [line] = expandTemplate([item()], inputs);
    expect(line?.unitCostTenThou).toBe(28000n);
    expect(line?.unitPriceTenThou).toBe(40000n);
  });

  it('carries provenance and the allowance flag through', () => {
    const [line] = expandTemplate([item({ isAllowance: true })], inputs);
    expect(line?.rateItemId).toBe('rate-1');
    expect(line?.costCodeId).toBe('cost-1');
    expect(line?.isAllowance).toBe(true);
  });

  it('emits no internal bookkeeping fields', () => {
    const [line] = expandTemplate([item()], inputs);
    expect(Object.keys(line ?? {}).filter((k) => k.startsWith('_'))).toEqual([]);
  });

  it('returns nothing for an empty template', () => {
    expect(expandTemplate([], inputs)).toEqual([]);
  });
});
