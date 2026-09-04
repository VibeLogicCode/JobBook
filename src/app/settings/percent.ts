import { formatRate, parseRateToTenThou } from '@/lib/money/format';

/**
 * Percentages, as a person types and reads them.
 *
 * A rate is stored in ten-thousandths of a FRACTION -- 13% is 1300, not 130000
 * -- because that is the scale the calculation engine multiplies in. Nobody
 * types a tax rate as 0.13, so this converts at the edge, in one place, by
 * composing the money parsers rather than reaching for `parseFloat(x) * 10000`.
 *
 * Basis points use the same scale: 25% is 2500 basis points and 2500
 * ten-thousandths of 0.25. `targetMarginBp` therefore parses through here too.
 */

/**
 * `formatRate` always emits four decimals, and multiplying by a hundred first
 * guarantees the last two of them are zeros -- so dropping them is exact
 * rather than a rounding decision made in a template.
 */
export function formatPercent(rateTenThou: bigint): string {
  return formatRate(rateTenThou * 100n).slice(0, -2);
}

/**
 * Returns null on anything that is not a percentage with at most two decimal
 * places, because two is all the ten-thousandths scale holds exactly. Refusing
 * beats rounding: a tax rate quietly altered in the third decimal reprices
 * every future quote, and Quebec's 9.975% is a column limit to be raised in a
 * migration, not a number to silently turn into 9.98%.
 */
export function parsePercentToTenThou(raw: string): bigint | null {
  const asRate = parseRateToTenThou(raw);
  if (asRate === null) return null;
  if (asRate % 100n !== 0n) return null;
  return asRate / 100n;
}
