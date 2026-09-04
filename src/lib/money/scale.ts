/**
 * Scaled-integer arithmetic. The correctness of every figure in the product
 * rests on this file, so it is pure, imports nothing, and rounds at exactly
 * two defined boundaries.
 */

/** Quantities are integer thousandths: 1240.500 sqft -> 1240500n. */
export const QTY_SCALE = 1000n;
/** Rates and percents are integer ten-thousandths: $4.0000 -> 40000n; 13% -> 1300n. */
export const RATE_SCALE = 10000n;
/** Money is integer cents. */
export const CENT_SCALE = 100n;
/**
 * qtyMilli * rateTenThou carries a scale of 10^7. Cents carry 10^2, so the
 * product divides by 10^5 to land on cents.
 */
export const LINE_DIVISOR = (QTY_SCALE * RATE_SCALE) / CENT_SCALE;

/**
 * Integer division rounding halves away from zero.
 *
 * Half-away-from-zero is what Canadian tax arithmetic expects, and it keeps a
 * credit and its matching charge symmetric -- a deductive change order must
 * reverse exactly what the original line added.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('denominator must not be zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * A line's total in cents.
 *
 * BigInt is required, not defensive: a maximum quantity times a maximum rate is
 * approximately 1e18, past Number.MAX_SAFE_INTEGER at 9.007e15. Computing this
 * with `number` loses precision silently on large quotes.
 */
export function lineTotalCents(qtyMilli: bigint, rateTenThou: bigint): bigint {
  return divRoundHalfUp(qtyMilli * rateTenThou, LINE_DIVISOR);
}

/** A percentage of a cent amount, rounded once to cents. */
export function applyPercentCents(baseCents: bigint, percentTenThou: bigint): bigint {
  return divRoundHalfUp(baseCents * percentTenThou, RATE_SCALE);
}

/**
 * Margin in basis points: (revenue - cost) / revenue.
 *
 * Margin and markup are different numbers on the same figures -- a 33.33%
 * markup is a 25% margin -- and conflating them is how a contractor quotes
 * himself into a loss. Both are exposed so the interface can show one and
 * label the other.
 */
export function marginBasisPoints(revenueCents: bigint, costCents: bigint): number {
  if (revenueCents === 0n) return 0;
  return Number(divRoundHalfUp((revenueCents - costCents) * RATE_SCALE, revenueCents));
}

/** Markup in basis points: (revenue - cost) / cost. */
export function markupBasisPoints(revenueCents: bigint, costCents: bigint): number {
  if (costCents === 0n) return 0;
  return Number(divRoundHalfUp((revenueCents - costCents) * RATE_SCALE, costCents));
}
