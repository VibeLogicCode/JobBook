/**
 * Whether a new tax rate would be in force alongside one already there.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GUARD IS NEEDED AT ALL
 * ---------------------------------------------------------------------------
 *
 * `computeTaxes` applies EVERY rate in force on the quote's date, and that is
 * correct rather than a bug -- a GST+PST province needs exactly that, and
 * `isCompound` exists because Quebec stacks one on the other. So nothing
 * downstream can distinguish a legitimate second tax from a duplicate of the
 * first, and nothing downstream should try.
 *
 * The supersede path in `settings/tax-rates/actions.ts` is careful: it closes
 * the outgoing row at `effectiveFrom - 1` and refuses one that was already
 * closed. But `addTaxRate` inserted with no check at all, so somebody
 * reaching for "Add" instead of "Supersede" created a second open-ended `HST`
 * -- after which every quote carried 26% tax. Silently, on the document a
 * customer signs, with the arithmetic entirely innocent.
 *
 * That is the shape of failure this codebase keeps meeting: a wrong number on
 * a customer-facing document, produced by correct code fed a row nobody
 * refused.
 *
 * ---------------------------------------------------------------------------
 * WHY IT MATCHES ON THE LABEL
 * ---------------------------------------------------------------------------
 *
 * The label is what makes two rows "the same tax" -- there is no other
 * candidate. It is what prints on the quote, what `quote_taxes` snapshots, and
 * what a person reads. Two rows labelled `HST` in force together are a
 * mistake; `GST` beside `PST` is a province.
 *
 * Compared case-insensitively and trimmed, for the reason the cost-code and
 * project-type lists give for their own indexes: `hst` and `HST ` are the same
 * tax to a person and to the CRA, and treating them as different is precisely
 * how the duplicate gets in through the door this guard is on.
 *
 * ---------------------------------------------------------------------------
 * DATES ARE INCLUSIVE AT BOTH ENDS
 * ---------------------------------------------------------------------------
 *
 * `selectRatesInForce` uses `effectiveFrom <= onDate && onDate <= effectiveTo`,
 * so a row whose `effectiveTo` is the new row's `effectiveFrom` is in force on
 * that day too. One day of double tax is still double tax, and it is the day
 * somebody would never think to check -- which is why the supersede path
 * subtracts a day rather than sharing the boundary.
 *
 * ISO dates compare correctly as strings, which is why they are stored that
 * way; `lib/quote/dates.ts` is the module that insists on the format.
 */

export interface RateWindow {
  label: string;
  /** ISO date, inclusive. */
  effectiveFrom: string;
  /** ISO date, inclusive. Null means "still in force". */
  effectiveTo: string | null;
}

function sameTax(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Do two closed-or-open date ranges share any day? */
function windowsOverlap(a: RateWindow, b: RateWindow): boolean {
  const aEndsBeforeB = a.effectiveTo !== null && a.effectiveTo < b.effectiveFrom;
  const bEndsBeforeA = b.effectiveTo !== null && b.effectiveTo < a.effectiveFrom;
  return !aEndsBeforeB && !bEndsBeforeA;
}

/**
 * The refusal sentence, or null to allow the write.
 *
 * Returns prose rather than a boolean because the caller's only useful
 * response is to show it, and because the sentence has to name SUPERSEDE --
 * a refusal that says only "that overlaps" reads as "you cannot change your
 * tax rate", and the person who believes that will go and edit the existing
 * row instead, which is the thing versioning exists to prevent.
 */
export function overlapProblem(
  existing: readonly RateWindow[],
  candidate: RateWindow,
): string | null {
  const clash = existing.find(
    (row) => sameTax(row.label, candidate.label) && windowsOverlap(row, candidate),
  );
  if (!clash) return null;

  const until = clash.effectiveTo === null ? 'with no end date' : `until ${clash.effectiveTo}`;
  return (
    `${clash.label.trim()} is already in force from ${clash.effectiveFrom} ${until}, and both ` +
    `would apply at once — every quote in the overlap would charge the tax twice. To change ` +
    `the rate, supersede the row that is in force instead: that closes it the day before the ` +
    `new one starts and leaves past quotes reading what they were issued at.`
  );
}
