import { z } from 'zod';

/**
 * The shape and the rules behind `/settings/clauses`.
 *
 * Its own copy of the two shared builders rather than an import from another
 * list's schema, following `line-groups/schema.ts` and `cost-codes/schema.ts`:
 * a list reaching into another list's module makes a change to either one a
 * change both screens have to be re-read against.
 *
 * ---------------------------------------------------------------------------
 * NO DUPLICATE-NAME MACHINERY HERE, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * `quote_clauses` carries no unique index. Two exclusions worded almost the
 * same are a tidiness problem and not a correctness one -- unlike two line
 * groups, which print as two sections with one name on a document somebody
 * signs. So this file has no `isDuplicateName` and no `takenBy`, because
 * nothing here can be refused for a collision.
 */

export const CLAUSE_LABELS: Record<string, string> = {
  kind: 'Kind',
  clauseText: 'Wording',
  sortOrder: 'Order',
  reason: 'Reason',
};

export const CLAUSE_KINDS = ['exclusion', 'assumption'] as const;
export type ClauseKind = (typeof CLAUSE_KINDS)[number];

export const CLAUSE_KIND_LABELS: Record<ClauseKind, string> = {
  exclusion: 'Not included',
  assumption: 'Assumed',
};

export const CLAUSE_KIND_SUMMARIES: Record<ClauseKind, string> = {
  exclusion: 'Work the price does not cover. Prints under "Not included".',
  assumption: 'What the price was based on. Prints under "This price assumes".',
};

/**
 * The sentence itself.
 *
 * FIVE HUNDRED characters, where the quote's own box takes four thousand. A
 * saved clause is one line the owner taps to add, and a paragraph in that
 * position is a button nobody can read on a phone. The long-form version
 * belongs on the quote, typed for that job.
 *
 * Trimmed, and internal newlines collapsed to a space: the quote appends each
 * of these AS A LINE, so a clause containing its own line breaks would arrive
 * as three lines the owner did not add.
 */
const clauseText = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .refine((value) => value !== '', 'is required')
  .refine((value) => value.length <= 500, 'must be 500 characters or fewer');

/** Blank means nought, which sorts first, and ties fall back to the wording. */
const optionalOrder = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || /^\d{1,6}$/.test(value), 'must be a whole number')
  .transform((value) => (value === '' ? 0 : Number(value)));

export const clauseFields = z.object({
  kind: z.enum(CLAUSE_KINDS, { message: 'must be either not included or assumed' }),
  clauseText,
  sortOrder: optionalOrder,
});

export type ClauseInput = z.output<typeof clauseFields>;

/** Form names to column names, so no action writes the mapping by hand. */
export function toClauseColumns(input: ClauseInput) {
  return { kind: input.kind, clauseText: input.clauseText, sortOrder: input.sortOrder };
}
