import { z } from 'zod';

/**
 * The shape and the rules behind `/settings/line-groups`.
 *
 * Copied from `app/settings/vendor-lists.ts` rather than imported from it: that
 * module is deliberately scoped to the two vendor lists it names in its own
 * docblock, and a third list reaching into it would make a future change to
 * either vendor list a change this screen has to be re-read against too. The
 * three things worth sharing -- a normalised name, an optional order, and the
 * one database error both screens have a sentence for -- are copied instead,
 * the same way `cost-codes/schema.ts` holds its own rather than reaching into
 * `vendor-lists.ts` for them.
 */

export const LINE_GROUP_LABELS: Record<string, string> = {
  name: 'Name',
  sortOrder: 'Order',
  reason: 'Reason',
};

/**
 * Trimmed, and internal runs of whitespace collapsed to one space.
 *
 * The unique index is on `lower(name)`, which catches case. It cannot catch
 * "Available upgrades" against "Available  upgrades" -- two rows, one section
 * heading, and a difference nobody sees on this screen. Collapsing here is
 * what makes the index's promise the promise a reader would expect.
 */
const listName = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .refine((value) => value !== '', 'is required')
  .refine((value) => value.length <= 120, 'must be 120 characters or fewer');

/** Blank means nought, which sorts first and ties fall back to the name. */
const optionalOrder = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || /^\d{1,6}$/.test(value), 'must be a whole number')
  .transform((value) => (value === '' ? 0 : Number(value)));

export const lineGroupFields = z.object({
  name: listName,
  sortOrder: optionalOrder,
});

export type LineGroupInput = z.output<typeof lineGroupFields>;

/**
 * Form names to column names, so no action writes the mapping by hand and
 * drifts from it. Same reason `cost-codes/schema.ts` has one.
 */
export function toLineGroupColumns(input: LineGroupInput) {
  return { name: input.name, sortOrder: input.sortOrder };
}

/**
 * Postgres's unique-violation SQLSTATE, found wherever in the error it is.
 *
 * Caught rather than pre-checked because a check followed by an insert is two
 * statements with a gap between them, and the gap is where the second tab's
 * insert lands. The chain walk is bounded, because an error whose `cause` is
 * itself would otherwise spin -- see `vendor-lists.ts` for the fuller version
 * of this note.
 */
export function isDuplicateName(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
