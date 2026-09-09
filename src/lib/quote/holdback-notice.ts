/**
 * Whether a quote document says anything about holdback, and what.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `print/quote/[id]/page.tsx` printed `org.holdbackTermsText` unconditionally.
 * It never read the quote's own percentage, so a job that withheld nothing
 * still told the customer that ten percent was being retained from every
 * payment -- a false statement about money, on the document a homeowner signs.
 *
 * What makes it worth a file of its own is the comment that was already in
 * `settings/financial/page.tsx`, justifying the design:
 *
 *   "Only a default, not a company-wide rate: it is stored per quote, so a job
 *    that withholds nothing prints no holdback block. A single shared
 *    percentage would put a withholding line on every residential quote, where
 *    most homeowners never expect one."
 *
 * That is the right design and the reasoning is sound. **The code did not do
 * it.** The comment described behaviour that had never been implemented, which
 * is worse than no comment: it is the reasoning a reviewer would check the
 * screen against, agree with, and move on.
 *
 * So the rule is a function with tests rather than a condition inside a
 * template. `tests/integration/print-quote.test.ts` does cover the real
 * document, but it needs a running server and a browser and skips without
 * them -- so a rule living only in that JSX is a rule that goes unchecked on
 * an ordinary run.
 *
 * ---------------------------------------------------------------------------
 * WHY IT FAILS CLOSED
 * ---------------------------------------------------------------------------
 *
 * Every uncertain input yields silence. Null, zero, negative, malformed: none
 * of them prints. The asymmetry is deliberate, because the two failures are
 * not comparable. Omitting a holdback paragraph from a quote that does withhold
 * understates what the customer will be invoiced, and he finds out at the first
 * draw. ANNOUNCING a holdback on a quote that withholds nothing is a term he
 * did not agree to, on a document he signs, about money.
 */

/**
 * Does this quote withhold anything?
 *
 * `quotes.holdback_pct_ten_thou` is nullable, and `lib/invoice/repository.ts`
 * fixes what absence means: the contract withholds nothing. It refuses to fall
 * back to the organization default there, and this agrees with it -- a
 * jurisdiction's customary percentage is not a term of a contract that does not
 * mention it.
 *
 * Takes the value as it crosses the wire: `rate()` is
 * `bigint(name, { mode: 'bigint' })` holding TEN-THOUSANDTHS, so ten percent
 * is `100000n`, and `WireQuote` carries it as a string the way every other
 * rate on the wire does (`WireLine.unitCostTenThou`, `sellRateTenThou`).
 *
 * Parsed with `BigInt` rather than `Number`, for the reason this whole
 * codebase keeps money and rates as scaled integers: a float would introduce
 * an approximation into the one decision about whether to make a statement
 * about money.
 *
 * Parsing here rather than at each call site is the point. A caller comparing
 * `!== null` would print on a stored zero -- which is exactly what a person
 * clearing the field in Settings leaves behind.
 */
export function withholdsHoldback(pctTenThou: string | null): boolean {
  if (pctTenThou === null) return false;

  let value: bigint;
  try {
    value = BigInt(pctTenThou);
  } catch {
    // `BigInt('')` is 0n, but `BigInt('ten percent')` throws. Either way a
    // value we cannot read prints nothing, rather than throwing partway
    // through a document render: a quote that will not render at all is worse
    // than one missing a paragraph, and this is the only place deciding it.
    return false;
  }

  return value > 0n;
}

/**
 * The holdback paragraph for this quote, or null to print no paragraph.
 *
 * Both halves have to hold. A percentage with no terms text has nothing to
 * say; terms text with no percentage is the bug above. Whitespace-only text
 * counts as absent, because a blank paragraph under the "Payment" heading
 * reads as a document that lost something.
 */
export function holdbackNoticeFor(
  pctTenThou: string | null,
  termsText: string | null,
): string | null {
  if (!withholdsHoldback(pctTenThou)) return null;
  if (termsText === null || termsText.trim() === '') return null;
  return termsText;
}
