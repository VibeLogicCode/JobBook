import { describe, expect, it } from 'vitest';
import { addDays, yearOf } from '@/lib/quote/dates';

describe('addDays', () => {
  it('adds within a month', () => {
    expect(addDays('2026-09-01', 30)).toBe('2026-10-01');
  });

  it('crosses a month boundary', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-20', 30)).toBe('2027-01-19');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('is unmoved by a daylight saving change', () => {
    // Clocks go forward in Toronto on 8 March 2026. Arithmetic on a local
    // Date would land on 6 April here, a day early, because one of those
    // thirty days is only 23 hours long.
    expect(addDays('2026-03-07', 30)).toBe('2026-04-06');
  });

  it('subtracts on a negative count', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('returns the same date for zero', () => {
    expect(addDays('2026-09-04', 0)).toBe('2026-09-04');
  });

  it('refuses anything that is not an ISO date', () => {
    expect(() => addDays('01/09/2026', 1)).toThrow(/ISO date/);
    expect(() => addDays('2026-09-04T12:00:00Z', 1)).toThrow(/ISO date/);
  });
});

describe('yearOf', () => {
  it('reads the year from the string rather than parsing a Date', () => {
    expect(yearOf('2026-01-01')).toBe(2026);
    expect(yearOf('2026-12-31')).toBe(2026);
  });

  it('refuses a non-ISO value', () => {
    expect(() => yearOf('September 2026')).toThrow(/ISO date/);
  });
});

describe('a date that is shaped right and does not exist', () => {
  /**
   * The failure this guards is silent, not loud. `Date.UTC(2026, 12, 40)` does
   * not complain -- it rolls over and returns 2027-02-09 -- so before the
   * check, every one of these produced a confident answer to a question about
   * a date that never happened.
   */
  it('is refused by addDays', () => {
    expect(() => addDays('2026-13-40', 1)).toThrow(/ISO date/);
    expect(() => addDays('2026-02-30', 1)).toThrow(/ISO date/);
    expect(() => addDays('2026-04-31', 1)).toThrow(/ISO date/);
    expect(() => addDays('2026-00-10', 1)).toThrow(/ISO date/);
  });

  it('knows 2026 is not a leap year and 2028 is', () => {
    expect(() => addDays('2026-02-29', 0)).toThrow(/ISO date/);
    expect(addDays('2028-02-29', 0)).toBe('2028-02-29');
  });

  it('still accepts every real date it always did', () => {
    expect(addDays('2026-03-09', 3)).toBe('2026-03-12');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
