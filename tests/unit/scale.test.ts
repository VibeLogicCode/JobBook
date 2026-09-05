import { describe, expect, it } from 'vitest';
import {
  applyPercentCents,
  divRoundHalfUp,
  divRoundUp,
  lineTotalCents,
  marginBasisPoints,
  markupBasisPoints,
} from '@/lib/money/scale';

describe('divRoundUp', () => {
  it('rounds an exact multiple to itself', () => {
    expect(divRoundUp(12n, 3n)).toBe(4n);
  });

  it('rounds any remainder up rather than down', () => {
    expect(divRoundUp(13n, 3n)).toBe(5n);
  });

  it('is zero for a zero numerator', () => {
    expect(divRoundUp(0n, 3n)).toBe(0n);
  });

  it('throws on a zero denominator', () => {
    expect(() => divRoundUp(1n, 0n)).toThrow('denominator must be greater than zero');
  });

  it('throws on a negative denominator', () => {
    expect(() => divRoundUp(1n, -3n)).toThrow('denominator must be greater than zero');
  });

  it('throws on a negative numerator', () => {
    expect(() => divRoundUp(-1n, 3n)).toThrow('numerator must not be negative');
  });
});

describe('divRoundHalfUp', () => {
  it('rounds a half away from zero', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
  });

  it('rounds below a half down', () => {
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
  });

  it('divides exactly when there is no remainder', () => {
    expect(divRoundHalfUp(10n, 5n)).toBe(2n);
  });

  it('throws on a zero denominator', () => {
    expect(() => divRoundHalfUp(1n, 0n)).toThrow('denominator must not be zero');
  });
});

describe('lineTotalCents', () => {
  it('multiplies 1240.500 sqft by $4.0000 to $4962.00', () => {
    expect(lineTotalCents(1240500n, 40000n)).toBe(496200n);
  });

  it('multiplies 2 each by $720.0000 to $1440.00', () => {
    expect(lineTotalCents(2000n, 7200000n)).toBe(144000n);
  });

  it('rounds a half-cent up', () => {
    expect(lineTotalCents(1000n, 50n)).toBe(1n);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    expect(lineTotalCents(999999999n, 999999999n)).toBe(9999999980000n);
  });

  it('negates exactly, so a deductive line reverses its original', () => {
    expect(lineTotalCents(1240500n, -40000n)).toBe(-496200n);
  });
});

describe('applyPercentCents', () => {
  it('takes 13% of $84,300.00', () => {
    expect(applyPercentCents(8430000n, 1300n)).toBe(1095900n);
  });

  it('rounds a half-cent up', () => {
    expect(applyPercentCents(5n, 1000n)).toBe(1n);
  });

  it('handles a negative base', () => {
    expect(applyPercentCents(-100000n, 1000n)).toBe(-10000n);
  });
});

describe('marginBasisPoints', () => {
  it('reports margin as (revenue - cost) / revenue', () => {
    expect(marginBasisPoints(10000n, 7500n)).toBe(2500);
  });

  it('is negative when cost exceeds revenue', () => {
    expect(marginBasisPoints(10000n, 12000n)).toBe(-2000);
  });

  it('returns 0 for zero revenue rather than dividing by zero', () => {
    expect(marginBasisPoints(0n, 5000n)).toBe(0);
  });
});

describe('markupBasisPoints', () => {
  it('differs from margin on the same figures', () => {
    expect(markupBasisPoints(10000n, 7500n)).toBe(3333);
    expect(marginBasisPoints(10000n, 7500n)).toBe(2500);
  });

  it('returns 0 for zero cost rather than dividing by zero', () => {
    expect(markupBasisPoints(10000n, 0n)).toBe(0);
  });
});
