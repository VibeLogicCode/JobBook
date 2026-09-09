/**
 * Whether a company's document code may be used, and what to say if not.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A GUARD AND NOT A `maxLength` ON A FORM FIELD
 * ---------------------------------------------------------------------------
 *
 * The code goes on every quote, change order, invoice and job number the
 * company ever issues, it is read down the phone, and it is typed into
 * somebody else's accounting system. It is also written ONCE per year per
 * kind: `document_sequences` stores the composed prefix against
 * `(company_id, kind, year)`, so a code accepted in January is what that
 * year's documents carry even if it is corrected in March.
 *
 * So the moment to refuse a bad one is before the first document, and the
 * refusal has to say what to type instead. Same shape as
 * `lib/quote/tax-overlap.ts` and `lib/quote/unpriced.ts`: prose or null,
 * because the caller's only useful response is to show it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REFUSED, AND WHY EACH
 * ---------------------------------------------------------------------------
 *
 * **Underscores and dashes.** The format owns both -- the composed number is
 * `{code}_{KIND}-{YEAR}-{SEQ}` -- so `RENO_` would become `RENO__QT` and
 * `RE-NO` would put a third dash in a string a person parses by counting
 * dashes.
 *
 * **Anything but letters and digits.** A space or a slash reaches a PDF
 * filename (`quote-${number}-v${version}.pdf`) and a URL.
 *
 * **More than six characters.** `RENOVATIONS_INV-2026-0001` is not a document
 * number anybody reads twice. Six is enough for `RENO`, `MAPLE` or `SVC` and
 * short enough to stay legible beside the rest.
 *
 * **A code another company already uses.** The unique index on
 * `document_sequences (kind, year, prefix)` refuses the clash, but it refuses
 * it at the moment somebody issues a document rather than at the moment
 * somebody chooses the code -- and the error it produces names an index, not a
 * decision. Caught here, the person choosing is the person told.
 *
 * Compared case-insensitively, because codes are normalised to upper case:
 * `reno` and `RENO` are one code to a reader and to this guard.
 */

/** Trimmed and upper-cased. The stored form, so two rows cannot differ by case. */
export function normalizePrefix(candidate: string): string {
  return candidate.trim().toUpperCase();
}

const SHAPE = /^[A-Z0-9]+$/;
const MAX = 6;

export interface PrefixInUse {
  /** How the other company is named in the refusal. "A company" is not a thing to go and look at. */
  displayName: string;
  prefix: string;
}

/**
 * The refusal sentence, or null to allow the code.
 *
 * An empty candidate is ALLOWED and means "no code": one company needs nothing
 * to distinguish it from, and `QT-2026-0001` is shorter and says as much. The
 * caller stores null.
 */
export function prefixProblem(candidate: string, taken: readonly PrefixInUse[]): string | null {
  const code = normalizePrefix(candidate);
  if (code === '') return null;

  if (!SHAPE.test(code)) {
    return (
      'A company code can only use letters and numbers — no spaces, dashes or underscores. ' +
      'The number is built as RENO_QT-2026-0001, so the underscore and the dashes are already ' +
      'part of the format.'
    );
  }

  if (code.length > MAX) {
    return (
      `${code} is ${code.length} characters, and a company code has to fit in a number somebody ` +
      `reads down the phone. Use ${MAX} or fewer — RENO rather than RENOVATIONS.`
    );
  }

  const clash = taken.find((row) => normalizePrefix(row.prefix) === code);
  if (clash) {
    return (
      `${clash.displayName} already issues its documents as ${code}, and two companies sharing a ` +
      `code would number two different invoices identically. Pick another code for this one.`
    );
  }

  return null;
}
