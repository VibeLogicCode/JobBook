import { describe, expect, it } from 'vitest';
import { holdbackNoticeFor, withholdsHoldback } from '@/lib/quote/holdback-notice';

/**
 * The quote document told customers a holdback was being retained on jobs that
 * retained nothing.
 *
 * `print/quote/[id]/page.tsx` printed `org.holdbackTermsText` unconditionally
 * and never read the quote's own percentage -- while
 * `settings/financial/page.tsx` justified storing holdback per quote in as
 * many words: "it is stored per quote, so a job that withholds nothing prints
 * no holdback block." That sentence described behaviour the code did not have,
 * which is the worst kind of comment: the reasoning recorded to defend a
 * design was itself the thing that was false.
 *
 * The predicate lives here, unit-tested, rather than inline in the template.
 * `tests/integration/print-quote.test.ts` covers the document but needs a
 * running server and a browser, so a rule that only exists inside that JSX is
 * a rule nothing checks on a normal run.
 */

describe('withholdsHoldback', () => {
  it('is false when the quote carries no holdback', () => {
    // Nullable on purpose. `lib/invoice/repository.ts` states the meaning:
    // absent means the contract withholds nothing, and it deliberately
    // refuses to fall back to the organization default.
    expect(withholdsHoldback(null)).toBe(false);
  });

  it('is false at zero', () => {
    // What clearing the field in Settings leaves behind.
    expect(withholdsHoldback('0')).toBe(false);
  });

  it('is true for a real percentage', () => {
    // TEN-THOUSANDTHS. `rate()` is a bigint column, so ten percent is
    // 100000 and two and a half percent is 25000 -- not '10.0000'. Written
    // out because a decimal-looking string here would be a test agreeing
    // with a misreading of the schema rather than with the schema.
    expect(withholdsHoldback('100000')).toBe(true);
    expect(withholdsHoldback('25000')).toBe(true);
    // One ten-thousandth of a percent still withholds something.
    expect(withholdsHoldback('1')).toBe(true);
  });

  it('is false for a negative, which is not a withholding', () => {
    // Nothing should write one. If something does, the document must not
    // announce a holdback it cannot explain.
    expect(withholdsHoldback('-100000')).toBe(false);
  });

  it('is false for a value it cannot read', () => {
    // Fails closed. A malformed rate must not put a statement about money on
    // a customer's contract.
    // `BigInt('')` is 0n and `BigInt('ten percent')` throws. Both print
    // nothing.
    expect(withholdsHoldback('')).toBe(false);
    expect(withholdsHoldback('ten percent')).toBe(false);
    expect(withholdsHoldback('10.0000')).toBe(false);
  });
});

describe('holdbackNoticeFor', () => {
  const terms = 'A 10% statutory holdback is retained from each payment.';

  it('prints nothing when the job withholds nothing', () => {
    // THE BUG. This returned the terms text before.
    expect(holdbackNoticeFor(null, terms)).toBeNull();
    expect(holdbackNoticeFor('0', terms)).toBeNull();
  });

  it('prints the terms when the job does withhold', () => {
    expect(holdbackNoticeFor('100000', terms)).toBe(terms);
  });

  it('prints nothing when there is no terms text to print', () => {
    expect(holdbackNoticeFor('100000', null)).toBeNull();
    expect(holdbackNoticeFor('100000', '')).toBeNull();
    // Whitespace is not terms. A blank paragraph under a "Payment" heading
    // reads as a document that lost something.
    expect(holdbackNoticeFor('100000', '   ')).toBeNull();
  });
});
