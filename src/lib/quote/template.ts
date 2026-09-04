import { QTY_SCALE, RATE_SCALE, divRoundHalfUp } from '@/lib/money/scale';
import type { CalcMode, LineInput } from '@/lib/quote/types';

/** Where a template item's quantity comes from. */
export type QtySource = 'area' | 'washrooms' | 'kitchens' | 'bedrooms' | 'fixed' | 'manual';

export interface ScopeInputs {
  areaSqftMilli: bigint;
  washroomCount: number;
  kitchenCount: number;
  bedroomCount: number;
}

export interface TemplateItem {
  code: string;
  description: string;
  lineGroup: string;
  sortOrder: number;
  calcMode: CalcMode;
  unitLabel: string;
  qtySource: QtySource;
  /** Units per source unit: 1 is 10000n, one pot light per 50 sqft is 200n. */
  qtyMultiplierTenThou: bigint;
  fixedQtyMilli: bigint | null;
  costRateTenThou: bigint;
  sellRateTenThou: bigint;
  isTaxable: boolean;
  isOptional: boolean;
  isAllowance: boolean;
  /** Copied to the line as provenance. Never read back for pricing. */
  rateItemId: string | null;
  costCodeId: string | null;
}

function sourceQtyMilli(source: QtySource, inputs: ScopeInputs, fixed: bigint | null): bigint {
  switch (source) {
    case 'area':
      return inputs.areaSqftMilli;
    case 'washrooms':
      return BigInt(inputs.washroomCount) * QTY_SCALE;
    case 'kitchens':
      return BigInt(inputs.kitchenCount) * QTY_SCALE;
    case 'bedrooms':
      return BigInt(inputs.bedroomCount) * QTY_SCALE;
    case 'fixed':
      return fixed ?? 0n;
    case 'manual':
      return 0n;
  }
}

/**
 * Turns a scope template plus the owner's measurements into quote lines.
 *
 * This is the standardisation the product exists for: enter square footage and
 * room counts, get a consistent line set, then adjust. Quantity derives as
 * `source value x multiplier`, which covers every case described -- drywall is
 * area x 1, pot lights are area x 0.02, a washroom rough-in is washrooms x 1 --
 * without introducing a formula language.
 *
 * Rates are copied, not referenced. A line priced today must still print the
 * same figure after the rate item behind it is edited.
 */
export function expandTemplate(items: TemplateItem[], inputs: ScopeInputs): LineInput[] {
  const lines: LineInput[] = [];

  for (const item of items) {
    const source = sourceQtyMilli(item.qtySource, inputs, item.fixedQtyMilli);
    const qtyMilli =
      item.qtySource === 'manual'
        ? 0n
        : divRoundHalfUp(source * item.qtyMultiplierTenThou, RATE_SCALE);

    // A derived quantity of zero means the scope does not include the item, so
    // it is dropped: a basement with no kitchen should not produce a kitchen
    // line the owner has to delete. Two exceptions -- 'manual' items, where zero
    // is the expected starting value, and flat or percent items, whose price
    // does not read a quantity at all.
    const quantityMatters = item.calcMode === 'qty' && item.qtySource !== 'manual';
    if (quantityMatters && qtyMilli === 0n) continue;

    lines.push({
      code: item.code,
      description: item.description,
      lineGroup: item.lineGroup,
      sortOrder: item.sortOrder,
      calcMode: item.calcMode,
      unitLabel: item.unitLabel,
      qtyMilli,
      unitCostTenThou: item.costRateTenThou,
      unitPriceTenThou: item.sellRateTenThou,
      isTaxable: item.isTaxable,
      isOptional: item.isOptional,
      // An optional item starts excluded. The alternative -- included until
      // deselected -- silently inflates every quote built from a template with
      // upgrades in it.
      isIncluded: !item.isOptional,
      isAllowance: item.isAllowance,
      rateItemId: item.rateItemId,
      costCodeId: item.costCodeId,
    });
  }

  return lines;
}
