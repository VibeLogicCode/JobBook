/**
 * The shape of a quote line, before and after arithmetic.
 *
 * Money crosses this boundary as `number` cents rather than bigint: cents are
 * whole and a quote would have to reach ~$90 trillion before a double loses one.
 * The bigint discipline stays inside the arithmetic in `money/scale`, where the
 * intermediate products genuinely overflow.
 */

/**
 * How a line computes. Deliberately separate from its unit label, because the
 * label is a word on a page and this is a branch in the arithmetic; an earlier
 * design conflated the two and had no way to express linear feet, which is how
 * baseboard, trim, countertop and fencing are all priced.
 */
export type CalcMode = 'qty' | 'flat' | 'percent';

export interface LineInput {
  code: string;
  description: string;
  lineGroup: string;
  sortOrder: number;
  calcMode: CalcMode;
  /** Display only: 'sqft', 'ea', 'lnft', 'hr', 'm²'. Never affects arithmetic. */
  unitLabel: string;
  /** Integer thousandths. Ignored when calcMode is 'flat' or 'percent'. */
  qtyMilli: bigint;
  /**
   * Integer ten-thousandths. For 'percent', this IS the percentage. May be
   * negative, which is how discounts and deductive change orders are expressed.
   */
  unitCostTenThou: bigint;
  unitPriceTenThou: bigint;
  isTaxable: boolean;
  isOptional: boolean;
  isIncluded: boolean;
  /**
   * A customer-spendable placeholder, reconciled against actual cost later.
   * Passthrough only; no arithmetic effect.
   */
  isAllowance: boolean;
  /**
   * Provenance, never read for pricing. The snapshot rule freezes *prices*, not
   * *origin* -- without these, job costing cannot later group a quote by cost
   * code. Nullable for ad-hoc lines typed straight into a quote.
   */
  rateItemId: string | null;
  costCodeId: string | null;
}

export interface ComputedLine extends LineInput {
  lineCostCents: number;
  lineTotalCents: number;
  /**
   * For an EXCLUDED optional line: what accepting it actually adds to the quote,
   * grossed up by the percent lines it would then attract. Equals
   * lineTotalCents for included lines.
   */
  displayPriceCents: number;
}
