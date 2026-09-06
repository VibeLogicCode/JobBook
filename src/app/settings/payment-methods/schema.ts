import { z } from 'zod';
import { checkbox } from '@/app/settings/validate';

/**
 * The shape and the rules behind `/settings/payment-methods`.
 *
 * Closest in shape to `app/settings/vendor-lists.ts`'s vendor type half,
 * rather than to `project-lists.ts`'s plain pair: a payment method carries
 * `isOnAccount`, a flag riding on the row exactly the way
 * `vendor_types.is_subcontractor` does, and the same asymmetry follows --
 * `newPaymentMethodFields` carries it and `paymentMethodFields` (what an EDIT
 * may change) does not. See `db/schema/payment-methods.ts` for what the flag
 * means and why it is fixed once a row exists.
 */

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  name: 'Name',
  isOnAccount: 'Means the money has not left yet',
  sortOrder: 'Order',
  reason: 'Reason',
};

/**
 * Trimmed, and internal runs of whitespace collapsed to one space -- matching
 * every other maintained list, for the reason `vendor-lists.ts`'s `listName`
 * gives: the unique index is on `lower(name)` and cannot by itself catch
 * "Debit" against "Debit  ".
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

/** What an EDIT may change. The on-account flag is not on this list. */
export const paymentMethodFields = z.object({
  name: listName,
  sortOrder: optionalOrder,
});

export type PaymentMethodInput = z.output<typeof paymentMethodFields>;

/**
 * What a NEW method carries: the edit fields plus the one decision that can
 * only ever be made once.
 *
 * A browser sends nothing at all for a box that is not ticked, so absent is
 * the off state rather than an error: "this method settles immediately" is a
 * real answer and the commonest one.
 */
export const newPaymentMethodFields = paymentMethodFields.extend({
  isOnAccount: checkbox,
});

export type NewPaymentMethodInput = z.output<typeof newPaymentMethodFields>;

/**
 * Form names to column names, so no action writes the mapping by hand and
 * drifts from it.
 *
 * It takes the EDIT shape on purpose -- `isOnAccount` is set once by
 * `createPaymentMethod` from `newPaymentMethodFields` and is not part of any
 * mapping an update could reach.
 */
export function toPaymentMethodColumns(input: PaymentMethodInput) {
  return { name: input.name, sortOrder: input.sortOrder };
}

/* -------------------------------------------------------------------------
   The one database error the screen has a sentence for
   ------------------------------------------------------------------------- */

/**
 * Postgres's unique-violation SQLSTATE, found wherever in the error it is.
 *
 * Caught rather than pre-checked because a check followed by an insert is two
 * statements with a gap between them, and the gap is where the second tab's
 * insert lands. The chain walk matches `vendor-lists.ts`'s, for the same
 * reason: every write here runs inside a transaction, and Drizzle wraps a
 * transaction's failure in a `DrizzleQueryError` that carries the original on
 * `cause`.
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
 * A retired or voided row still has to appear in the picker of an expense that
 * already carries it: a select whose `defaultValue` matches no option silently
 * shows the FIRST one instead, and the next save would refile that expense
 * under whatever happened to sort first.
 */
export function listOptionLabel(row: ListRow): string {
  if (row.recordStatus === 'void') return `${row.name} (void)`;
  return row.isActive ? row.name : `${row.name} (retired)`;
}
