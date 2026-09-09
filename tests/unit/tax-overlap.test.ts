import { describe, expect, it } from 'vitest';
import { overlapProblem, type RateWindow } from '@/lib/quote/tax-overlap';

/**
 * Adding a tax rate that is in force at the same time as one already there.
 *
 * `computeTaxes` applies EVERY rate in force on the date, and that is correct
 * -- a GST+PST province needs exactly that, which is what `isCompound` is for.
 * So nothing downstream can tell a legitimate second rate from a duplicate.
 *
 * The supersede path is careful: it closes the old row at `effectiveFrom - 1`
 * and refuses a row that was already closed. Nothing stopped somebody reaching
 * for "Add" instead and creating a second open-ended `HST`, after which every
 * quote carried 26% tax, silently, on a customer-facing document, with the
 * arithmetic entirely innocent.
 */

const hst = (from: string, to: string | null = null): RateWindow => ({
  label: 'HST',
  effectiveFrom: from,
  effectiveTo: to,
});

describe('overlapProblem', () => {
  it('permits the first rate of a label', () => {
    expect(overlapProblem([], hst('2026-01-01'))).toBeNull();
  });

  it('REFUSES a second open-ended row for the same label', () => {
    // The 26% bug.
    const problem = overlapProblem([hst('2020-01-01')], hst('2026-01-01'));
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/HST/);
    // The refusal has to name the way out, or it reads as "you cannot change
    // your tax rate".
    expect(problem).toMatch(/supersede/i);
  });

  it('permits a rate that starts after the previous one closed', () => {
    // Versioning by effective date is the intended path and must stay open.
    expect(overlapProblem([hst('2020-01-01', '2025-12-31')], hst('2026-01-01'))).toBeNull();
  });

  it('refuses a rate that starts on the day the previous one ends', () => {
    // `effectiveTo` is INCLUSIVE -- the supersede path sets it to
    // `effectiveFrom - 1` precisely so the windows do not touch. A rate
    // starting on the closing day would be two rates in force for one day,
    // which is one day of double tax.
    expect(overlapProblem([hst('2020-01-01', '2026-01-01')], hst('2026-01-01'))).not.toBeNull();
  });

  it('refuses a rate that starts before an existing one and runs into it', () => {
    // Backdating. A correction entered as an addition rather than a
    // supersede.
    expect(overlapProblem([hst('2026-01-01')], hst('2020-01-01'))).not.toBeNull();
  });

  it('refuses a rate wholly inside an existing window', () => {
    expect(
      overlapProblem([hst('2020-01-01', '2030-01-01')], hst('2026-01-01', '2026-06-30')),
    ).not.toBeNull();
  });

  it('permits a different label in force at the same time', () => {
    // GST and PST together is the whole reason `computeTaxes` applies several,
    // so this must not be refused.
    const gst: RateWindow = { label: 'GST', effectiveFrom: '2020-01-01', effectiveTo: null };
    const pst: RateWindow = { label: 'PST', effectiveFrom: '2020-01-01', effectiveTo: null };
    expect(overlapProblem([gst], pst)).toBeNull();
  });

  it('compares labels case-insensitively and ignoring surrounding space', () => {
    // "hst" and "HST " are the same tax to a person and to the CRA. Treating
    // them as different is how the double-tax row gets in through the door
    // this guard is on.
    expect(overlapProblem([hst('2020-01-01')], { ...hst('2026-01-01'), label: ' hst ' })).not.toBeNull();
  });
});
