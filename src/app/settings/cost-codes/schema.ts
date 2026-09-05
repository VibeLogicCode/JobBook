import { z } from 'zod';

/**
 * The shape a cost code arrives in from a form, plus the two rules about the
 * hierarchy that are worth writing once.
 *
 * A cost code is not a price, so nothing here parses a scaled integer the way
 * `rates/schema.ts` does. What it does carry instead is the code itself, and a
 * cost code's text matters more than most: Phase 3 groups every receipt,
 * purchase order and labour entry by it, and the price-list importer matches a
 * pasted column against it without regard to case
 * (`lib/import/preview.ts` upper-cases both sides). So the code is normalised
 * here rather than stored as typed -- `02-40` and `02-40 ` and `dem` and `DEM`
 * are one code, and the unique index only sees one of them.
 */

export const COST_CODE_LABELS: Record<string, string> = {
  code: 'Code',
  name: 'Name',
  parentId: 'Sits under',
  category: 'Spend category',
  sortOrder: 'Order',
  reason: 'Reason',
};

/**
 * The spend categories, offered as a list rather than typed free.
 *
 * `cost_codes.category` is a plain text column, so nothing in the database
 * stops "Labour", "labour" and "Labor" being three categories. That is
 * survivable until year end, when the export groups by it and reports three
 * lines for one thing. A list is the smaller cost: this is a column somebody
 * fills in once per code and reads for the rest of the deployment's life.
 *
 * The five names are the ones a job-costing export is expected to separate --
 * what you paid people, what you bought, what you hired others to do, what you
 * rented, and everything left over. None of them is specific to a trade, a
 * province or a company.
 */
export const CATEGORY_LABELS = {
  labour: 'Labour',
  material: 'Material',
  subcontract: 'Subcontract',
  equipment: 'Equipment',
  other: 'Other',
} as const;

export type Category = keyof typeof CATEGORY_LABELS;

export const CATEGORY_OPTIONS = (
  Object.keys(CATEGORY_LABELS) as Category[]
).map((value) => ({ value, label: CATEGORY_LABELS[value] }));

/** Whether a stored value is one this screen knows how to label. */
export function isCategory(value: string | null): value is Category {
  return value !== null && Object.hasOwn(CATEGORY_LABELS, value);
}

/**
 * What a code may be made of.
 *
 * Letters, digits, and the four separators a numbering standard actually uses.
 * The exclusions are the point: a comma, a semicolon, a pipe or a tab inside a
 * cost code silently breaks the price-list importer, which splits a pasted
 * line on exactly those four characters. A code that cannot survive a paste is
 * a code that fails months later, in a file nobody kept.
 */
const CODE_SHAPE = /^[A-Z0-9][A-Z0-9 ./_-]*$/;

const codeField = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine((value) => value !== '', 'is required')
  .refine((value) => value.length <= 60, 'must be 60 characters or fewer')
  .refine(
    (value) => CODE_SHAPE.test(value),
    'may hold letters, digits, spaces and . - _ / only, and must start with a letter or a digit',
  );

const optionalUuid = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value === '' ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    'is not a cost code on the list',
  )
  .transform((value) => (value === '' ? null : value));

const categoryField = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || isCategory(value), 'is not one of the categories offered')
  .transform((value) => (value === '' ? null : (value as Category)));

const optionalOrder = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || /^\d{1,6}$/.test(value), 'must be a whole number')
  .transform((value) => (value === '' ? 0 : Number(value)));

export const costCodeFields = z.object({
  code: codeField,
  name: z.string().trim().min(1, 'is required').max(200, 'must be 200 characters or fewer'),
  parentId: optionalUuid,
  category: categoryField,
  sortOrder: optionalOrder,
});

export type CostCodeInput = z.output<typeof costCodeFields>;

/**
 * Form names to column names, so no action writes the mapping by hand and
 * drifts from it. Same reason `rates/schema.ts` has one.
 */
export function toColumns(input: CostCodeInput) {
  return {
    code: input.code,
    name: input.name,
    parentId: input.parentId,
    category: input.category,
    sortOrder: input.sortOrder,
  };
}

/* -------------------------------------------------------------------------
   The one database error the screen has a sentence for
   ------------------------------------------------------------------------- */

/**
 * Postgres's unique-violation SQLSTATE, found wherever in the error it is.
 *
 * Caught rather than pre-checked because a check followed by an insert is two
 * statements with a gap between them, and the gap is where the second tab's
 * insert lands.
 *
 * The chain walk is the part worth keeping. `rates/actions.ts` reads `.code`
 * off the error directly and is right to, because its insert is a bare
 * statement and the driver's error arrives intact. Every write in the cost
 * code actions runs inside a transaction -- a parent has to still be a
 * division at the moment of the write, not merely when the form was rendered
 * -- and Drizzle wraps a transaction's failure in a `DrizzleQueryError` that
 * carries the original on `cause`. Reading only the top of that turns "that
 * code is already taken" into an unexplained failure with the failed SQL and
 * its bound parameters printed on the screen, which is how this was found.
 *
 * Lives here rather than beside the actions because a `'use server'` file may
 * export nothing but async server actions, and an untested error predicate is
 * how the bug got in.
 */
export function isDuplicateCode(error: unknown): boolean {
  let current: unknown = error;
  // Bounded, because an error whose `cause` is itself would otherwise spin.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* -------------------------------------------------------------------------
   The hierarchy
   ------------------------------------------------------------------------- */

/** The columns a parent has to be judged on. Nothing else is read. */
export interface ParentRow {
  id: string;
  code: string;
  parentId: string | null;
  recordStatus: string;
}

/**
 * Whether a code may sit under the chosen parent, and if not, why in a
 * sentence somebody can act on.
 *
 * Pure, and separate from the action, because the rules are the interesting
 * part and the action is a transaction around them. The action supplies the
 * rows -- read inside the same transaction as the write, because a parent that
 * was a division when the form was rendered can be a section by the time the
 * button is pressed.
 *
 * Two levels, deliberately, and the schema says so: division, then section.
 * Deeper trees are where a cost code stops being a thing an owner can pick off
 * a list at the moment he is coding a receipt, which is the only moment that
 * matters. Two levels also make a cycle impossible without walking the tree:
 * if a parent must have no parent of its own, no chain longer than two exists
 * to close.
 */
export function parentProblem(input: {
  /** Null when the code is being created and therefore cannot be its own parent. */
  childId: string | null;
  childHasChildren: boolean;
  parent: ParentRow | undefined;
}): string | null {
  const { childId, childHasChildren, parent } = input;

  if (!parent) return 'The code you chose to file this under is not on the list.';
  if (parent.id === childId) return 'A cost code cannot sit under itself.';
  if (parent.recordStatus === 'void') {
    return `${parent.code} is void, so nothing new can be filed under it. Choose a division that still stands, or leave this a division of its own.`;
  }
  if (parent.parentId !== null) {
    return `${parent.code} already sits under another code. The hierarchy is two levels — a division, then the sections in it — so a section cannot hold sections of its own.`;
  }
  if (childHasChildren) {
    return 'This code already has sections filed under it, so it is a division. Move those sections elsewhere before filing this one under anything.';
  }
  return null;
}
