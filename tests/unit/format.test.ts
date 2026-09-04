import { describe, expect, it } from 'vitest';
import {
  formatBasisPoints,
  formatCents,
  formatQty,
  formatRate,
  parseAmountToCents,
  parseQtyToMilli,
  parseRateToTenThou,
  sumCents,
} from '@/lib/money/format';

describe('formatCents', () => {
  it('formats a positive amount with a currency symbol', () => {
    expect(formatCents(496200)).toBe('$4,962.00');
  });

  it('places the sign before the symbol for a negative amount', () => {
    expect(formatCents(-496200)).toBe('-$4,962.00');
  });

  it('adds a leading + for a positive amount when showSign is set', () => {
    expect(formatCents(496200, { showSign: true })).toBe('+$4,962.00');
  });

  it('does not double up the sign for a negative amount when showSign is set', () => {
    expect(formatCents(-496200, { showSign: true })).toBe('-$4,962.00');
  });

  it('does not sign zero even when showSign is set', () => {
    expect(formatCents(0, { showSign: true })).toBe('$0.00');
  });

  it('drops the symbol when currency is false', () => {
    expect(formatCents(496200, { currency: false })).toBe('4,962.00');
  });

  it('keeps the sign before the number when currency is false', () => {
    expect(formatCents(-496200, { currency: false })).toBe('-4,962.00');
  });

  it('is white-label: a different currencyCode changes the symbol, not a hardcoded $', () => {
    expect(formatCents(496200, { currencyCode: 'EUR' })).toBe('€4,962.00');
  });
});

describe('sumCents', () => {
  it('returns 0 for an empty array', () => {
    expect(sumCents([])).toBe(0);
  });

  it('adds a list of integer cents', () => {
    expect(sumCents([100, 200, 300])).toBe(600);
  });

  it('handles negative values in the sum', () => {
    expect(sumCents([100, -50])).toBe(50);
  });
});

describe('parseAmountToCents', () => {
  it('parses a plain decimal', () => {
    expect(parseAmountToCents('4962.00')).toBe(496200);
  });

  it('parses a $ prefix with thousands separators', () => {
    expect(parseAmountToCents('$4,962.00')).toBe(496200);
  });

  it('parses a CAD prefix with a space', () => {
    expect(parseAmountToCents('CAD 4,962.00')).toBe(496200);
  });

  it('parses a USD prefix with no space', () => {
    expect(parseAmountToCents('USD4962.00')).toBe(496200);
  });

  it('parses a unicode minus sign as negative', () => {
    expect(parseAmountToCents('−4,962.00')).toBe(-496200);
  });

  it('parses a non-breaking space used as a thousands separator', () => {
    expect(parseAmountToCents('4 962.00')).toBe(496200);
  });

  it('parses accounting parentheses as negative', () => {
    expect(parseAmountToCents('(1,440.00)')).toBe(-144000);
  });

  it('returns null for a blank string', () => {
    expect(parseAmountToCents('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseAmountToCents('   ')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseAmountToCents('abc')).toBeNull();
  });

  it('returns null for more than 2 decimal places', () => {
    expect(parseAmountToCents('4962.005')).toBeNull();
  });

  it('returns 0, not -0, for zero', () => {
    const result = parseAmountToCents('0');
    expect(result).toBe(0);
    expect(Object.is(result, -0)).toBe(false);
  });

  it('returns 0, not -0, for a negative-signed zero', () => {
    const result = parseAmountToCents('(0.00)');
    expect(result).toBe(0);
    expect(Object.is(result, -0)).toBe(false);
  });
});

describe('parseQtyToMilli', () => {
  it('parses up to 3 decimals', () => {
    expect(parseQtyToMilli('1240.5')).toBe(1240500n);
  });

  it('parses a whole number', () => {
    expect(parseQtyToMilli('2')).toBe(2000n);
  });

  it('returns null for more than 3 decimals', () => {
    expect(parseQtyToMilli('1.2345')).toBeNull();
  });

  it('returns null for a negative quantity', () => {
    expect(parseQtyToMilli('-5')).toBeNull();
  });

  it('returns null for a blank string', () => {
    expect(parseQtyToMilli('')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(parseQtyToMilli('abc')).toBeNull();
  });
});

describe('parseRateToTenThou', () => {
  it('parses a whole number to 4 implied decimals', () => {
    expect(parseRateToTenThou('4')).toBe(40000n);
  });

  it('parses up to 4 decimals', () => {
    expect(parseRateToTenThou('4.0025')).toBe(40025n);
  });

  it('accepts a negative rate as a discount', () => {
    expect(parseRateToTenThou('-4')).toBe(-40000n);
  });

  it('returns null for more than 4 decimals', () => {
    expect(parseRateToTenThou('4.00251')).toBeNull();
  });

  it('returns null for a blank string', () => {
    expect(parseRateToTenThou('')).toBeNull();
  });
});

describe('formatQty', () => {
  it('drops trailing zeroes', () => {
    expect(formatQty(1240500n)).toBe('1,240.5');
  });

  it('drops a wholly-zero fraction', () => {
    expect(formatQty(2000n)).toBe('2');
  });

  it('groups thousands with no fraction to show', () => {
    expect(formatQty(1234000n)).toBe('1,234');
  });

  it('formats a fraction with a zero whole part', () => {
    expect(formatQty(500n)).toBe('0.5');
  });
});

describe('formatRate', () => {
  it('always shows 4 decimals', () => {
    expect(formatRate(40000n)).toBe('4.0000');
  });

  it('keeps trailing zeroes at 4 decimals', () => {
    expect(formatRate(40025n)).toBe('4.0025');
  });

  it('handles a negative rate', () => {
    expect(formatRate(-40000n)).toBe('-4.0000');
  });
});

describe('formatBasisPoints', () => {
  it('formats a positive figure to one decimal percent', () => {
    expect(formatBasisPoints(2420)).toBe('24.2%');
  });

  it('formats a negative figure to one decimal percent', () => {
    expect(formatBasisPoints(-2000)).toBe('-20.0%');
  });

  it('formats zero', () => {
    expect(formatBasisPoints(0)).toBe('0.0%');
  });
});
