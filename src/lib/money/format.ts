/**
 * Presentation layer for money, quantities, and rates.
 *
 * scale.ts owns the integer arithmetic that every stored figure must survive;
 * this file only turns those integers into strings for a screen (formatting)
 * and turns what a person typed back into those integers (parsing). A bug
 * here is a wrong-looking number, not a wrong invoice -- but the parsers
 * still return `null` rather than guess, because a silently-wrong quote total
 * is worse than a rejected keystroke.
 */

import { QTY_SCALE, RATE_SCALE } from '@/lib/money/scale';

/** Money, in cents, formats and parses as a plain JS `number`, not `bigint`:
 * unlike a line total (qty * rate, which can overflow Number.MAX_SAFE_INTEGER),
 * a single amount a person can type or read on screen never approaches it. */

/**
 * The product is white-label -- a future deployment may bill in a currency
 * other than CAD -- so the symbol always comes from `Intl.NumberFormat`
 * against the caller's `currencyCode`, never a hardcoded `$` literal.
 */
export function formatCents(
  cents: number,
  opts?: { showSign?: boolean; currency?: boolean; locale?: string; currencyCode?: string }
): string {
  const { showSign = false, currency = true, locale = 'en-CA', currencyCode = 'CAD' } = opts ?? {};
  const formatter = new Intl.NumberFormat(locale, {
    style: currency ? 'currency' : 'decimal',
    currency: currency ? currencyCode : undefined,
    currencyDisplay: currency ? 'narrowSymbol' : undefined,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    // 'exceptZero' is what "showSign adds + only for positive values" means in
    // Intl's terms: it signs positive and negative but leaves zero bare.
    signDisplay: showSign ? 'exceptZero' : 'auto',
  });
  return formatter.format(cents / 100);
}

/** Kept as a named export, not `values.reduce(...)` inline at each call site,
 * so the "0 for empty" boundary case is defined once. */
export function sumCents(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

interface SplitNumeric {
  negative: boolean;
  integerPart: string;
  fractionPart: string;
}

/**
 * Common ground for the three parsers below: strip the ways a person or a
 * pasted spreadsheet cell might dress up a number (currency marks, accounting
 * parentheses, a unicode minus, stray spaces used as thousands separators)
 * down to a bare sign and digit string. What differs between an amount, a
 * quantity, and a rate is only how many fraction digits are legal and
 * whether negative is allowed -- both handled by the caller, not here.
 */
function splitNumericString(raw: string): SplitNumeric | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // U+2212 is the mathematical minus a keyboard or paste can produce; treat
  // it the same as the ASCII hyphen-minus everywhere else in this function.
  let s = trimmed.replace(/−/g, '-');
  // Ordinary spaces and non-breaking spaces both show up as thousands
  // separators or stray padding in copied figures; neither is ever
  // significant on its own, so strip all of them up front.
  s = s.replace(/[\s ]/g, '');

  let negative = false;
  if (s.length >= 2 && s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }

  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // A currency mark can precede the digits as a symbol, a code, or both, in
  // either order ("$CAD12", "CAD$12"); strip up to one of each.
  s = s.replace(/^(CAD|USD)/i, '').replace(/^\$/, '').replace(/^(CAD|USD)/i, '');
  s = s.replace(/,/g, '');

  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const [integerPart, fractionPart = ''] = s.split('.');
  return { negative, integerPart, fractionPart };
}

/**
 * Cents are built by concatenating digit strings rather than by multiplying
 * a parsed float by 100: `parseFloat('4962.00') * 100` is exact here, but it
 * is not exact for every two-decimal input, and a parser that is only
 * usually right is worse than one that is visibly strict.
 */
export function parseAmountToCents(raw: string): number | null {
  const split = splitNumericString(raw);
  if (!split) return null;
  if (split.fractionPart.length > 2) return null;

  const paddedFraction = split.fractionPart.padEnd(2, '0');
  const cents = Number(split.integerPart + paddedFraction);
  // Never surface -0: a zero amount reads the same regardless of which side
  // of the ledger it started on.
  return split.negative && cents !== 0 ? -cents : cents;
}

/** A quantity is never negative -- a discount lives on the rate, not here --
 * so any sign at all is treated as malformed input rather than coerced. */
export function parseQtyToMilli(raw: string): bigint | null {
  const split = splitNumericString(raw);
  if (!split) return null;
  if (split.negative) return null;
  if (split.fractionPart.length > 3) return null;

  const paddedFraction = split.fractionPart.padEnd(3, '0');
  return BigInt(split.integerPart + paddedFraction);
}

/**
 * Unlike a quantity, a negative rate is a legitimate business figure -- a
 * discount or a deductive change order both express as a negative rate
 * applied to a positive quantity -- so the sign is preserved, not rejected.
 */
export function parseRateToTenThou(raw: string): bigint | null {
  const split = splitNumericString(raw);
  if (!split) return null;
  if (split.fractionPart.length > 4) return null;

  const paddedFraction = split.fractionPart.padEnd(4, '0');
  const value = BigInt(split.integerPart + paddedFraction);
  return split.negative && value !== 0n ? -value : value;
}

/**
 * Quantities are typed and displayed as plain counts or measurements, so
 * trailing zeroes past the significant digits are noise (`2.000` each reads
 * as `2`, not as three decimals of precision the user asked for).
 */
export function formatQty(qtyMilli: bigint, locale = 'en-CA'): string {
  const negative = qtyMilli < 0n;
  const magnitude = negative ? -qtyMilli : qtyMilli;
  const whole = magnitude / QTY_SCALE;
  const fractionDigits = (magnitude % QTY_SCALE).toString().padStart(3, '0').replace(/0+$/, '');
  const wholeFormatted = new Intl.NumberFormat(locale).format(whole);
  const sign = negative ? '-' : '';
  return fractionDigits === '' ? `${sign}${wholeFormatted}` : `${sign}${wholeFormatted}.${fractionDigits}`;
}

/**
 * A rate's fixed 4 decimals are the inverse of formatQty's dropped ones: a
 * unit price is a precision the estimator chose deliberately (`$4.0000` vs
 * `$4.0025` is a real difference at scale), so it is never trimmed.
 */
export function formatRate(rateTenThou: bigint, locale = 'en-CA'): string {
  const negative = rateTenThou < 0n;
  const magnitude = negative ? -rateTenThou : rateTenThou;
  const whole = magnitude / RATE_SCALE;
  const fractionDigits = (magnitude % RATE_SCALE).toString().padStart(4, '0');
  const wholeFormatted = new Intl.NumberFormat(locale).format(whole);
  const sign = negative ? '-' : '';
  return `${sign}${wholeFormatted}.${fractionDigits}`;
}

/**
 * marginBasisPoints/markupBasisPoints in scale.ts return whole basis points
 * (2500 = 25.00%) for exactness; a screen showing a margin only needs one
 * decimal of percent, so the conversion -- and its rounding -- happens once,
 * here, rather than at every call site that wants to display one.
 */
export function formatBasisPoints(bp: number): string {
  return `${(bp / 100).toFixed(1)}%`;
}
