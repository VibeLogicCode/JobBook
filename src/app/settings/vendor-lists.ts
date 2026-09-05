import { z } from 'zod';
import { checkbox } from '@/app/settings/validate';

/**
 * The shapes and the rules behind the two vendor lists -- `/settings/vendor-types`
 * and `/settings/trades`.
 *
 * One module for two screens, rather than two near-identical copies. The
 * screens differ in what they are ABOUT and say so in their own prose; what
 * they share is a name that has to be normalised the same way, an order field,
 * and the one database error each has a sentence for. Held apart, those three
 * drift -- which is how a list ends up accepting "Framing " on one screen and
 * refusing it on the other.
 *
 * The asymmetry between them is the only interesting part, and it is
 * deliberate: a vendor type carries `isSubcontractor` and a trade does not,
 * and that flag appears in `newVendorTypeFields` and NOT in
 * `vendorTypeFields`. Adding a type lets you say whether its vendors perform
 * work; editing one never does. See `db/schema/vendor-lists.ts` for why.
 */

export const VENDOR_TYPE_LABELS: Record<string, string> = {
  name: 'Name',
  isSubcontractor: 'Counts as a subcontractor',
  sortOrder: 'Order',
  reason: 'Reason',
};

export const TRADE_LABELS: Record<string, string> = {
  name: 'Name',
  sortOrder: 'Order',
  reason: 'Reason',
};

/**
 * Trimmed, and internal runs of whitespace collapsed to one space.
 *
 * Both unique indexes are on `lower(name)`, which catches case. Neither can
 * catch "Windows and doors" against "Windows  and doors" -- two rows, one
 * trade, and a difference nobody sees on a screen. Collapsing here is what
 * makes the index's promise the promise a reader would expect it to be, and it
 * is the same normalisation `vendors/schema.ts` puts on a vendor's name for
 * the same reason.
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

/* -------------------------------------------------------------------------
   Vendor types
   ------------------------------------------------------------------------- */

/** What an EDIT may change. The subcontractor flag is not on this list. */
export const vendorTypeFields = z.object({
  name: listName,
  sortOrder: optionalOrder,
});

export type VendorTypeInput = z.output<typeof vendorTypeFields>;

/**
 * What a NEW type carries, which is the edit fields plus the one decision that
 * can only ever be made once.
 *
 * A browser sends nothing at all for a box that is not ticked, so absent is
 * the off state rather than an error: "this type does not perform work" is a
 * real answer and the commonest one.
 */
export const newVendorTypeFields = vendorTypeFields.extend({
  isSubcontractor: checkbox,
});

export type NewVendorTypeInput = z.output<typeof newVendorTypeFields>;

/**
 * Form names to column names, so no action writes the mapping by hand and
 * drifts from it. Same reason `settings/cost-codes/schema.ts` has one.
 *
 * It takes the EDIT shape on purpose. `isSubcontractor` is set once by
 * `createVendorType` from `newVendorTypeFields` and is not part of any
 * mapping an update could reach, so an edit path cannot acquire it by
 * accident -- which is the failure this whole design is about.
 */
export function toVendorTypeColumns(input: VendorTypeInput) {
  return { name: input.name, sortOrder: input.sortOrder };
}

/* -------------------------------------------------------------------------
   Trades
   ------------------------------------------------------------------------- */

export const tradeFields = z.object({
  name: listName,
  sortOrder: optionalOrder,
});

export type TradeInput = z.output<typeof tradeFields>;

export function toTradeColumns(input: TradeInput) {
  return { name: input.name, sortOrder: input.sortOrder };
}

/* -------------------------------------------------------------------------
   The one database error the screens have a sentence for
   ------------------------------------------------------------------------- */

/**
 * Postgres's unique-violation SQLSTATE, found wherever in the error it is.
 *
 * Caught rather than pre-checked because a check followed by an insert is two
 * statements with a gap between them, and the gap is where the second tab's
 * insert lands.
 *
 * The chain walk is the part worth keeping, and it is the corrected version
 * from `settings/cost-codes/schema.ts` rather than the naive one that reads
 * `.code` off the top. Every write on these screens runs inside a transaction
 * -- the void refusals count rows in the same transaction as the write -- and
 * Drizzle wraps a transaction's failure in a `DrizzleQueryError` that carries
 * the original on `cause`. Reading only the top of that turns "that name is
 * already taken" into an unexplained failure with the failed SQL and its bound
 * parameters printed on the screen.
 *
 * Lives here rather than beside the actions because a `'use server'` file may
 * export nothing but async server actions, and an untested error predicate is
 * how that bug got in the first time.
 */
export function isDuplicateName(error: unknown): boolean {
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
   What a picker calls a row
   ------------------------------------------------------------------------- */

/** The standing columns any list row is judged on. Nothing else is read. */
export interface ListRow {
  name: string;
  isActive: boolean;
  recordStatus: string;
}

/**
 * A row's name with its standing said out loud, for a select.
 *
 * A retired or voided row still has to appear in the picker of a vendor that
 * already carries it: a select whose `defaultValue` matches no option silently
 * shows the FIRST one instead, and the next save would refile that vendor
 * under whatever happened to sort first. Retiring "Roofing" must not quietly
 * turn the roofer into an excavator, and this is the function that stops it.
 */
export function listOptionLabel(row: ListRow): string {
  if (row.recordStatus === 'void') return `${row.name} (void)`;
  return row.isActive ? row.name : `${row.name} (retired)`;
}
