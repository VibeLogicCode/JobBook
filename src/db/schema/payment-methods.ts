import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';

/**
 * How money leaves, on the expense form -- the fifth hardcoded enum caught for
 * the reason `vendor_types`, `trades`, `project_types` and `lead_sources` were:
 * `payment_method` used to be `cash, debit, credit, cheque, etransfer, account`,
 * fixed at migration time, so the owner could not add "Line of credit" or
 * "Owner's personal card" without one. Migration 0019 is this fix applied a
 * fifth time.
 *
 * It is NOT the same shape as `project_types` and `lead_sources`, though. Those
 * two are plain lists with nothing riding on the name. This one carries a rule,
 * the way `vendor_types` does, and for the same reason it is worth reading
 * `db/schema/vendor-lists.ts` before touching this file.
 *
 * `expenses/schema.ts`'s option text for the old enum's `account` member said
 * it outright: "On account -- not paid yet". That is not a label, it is a
 * fact -- the one payment method that is not an instrument at all, because
 * nothing has actually left yet. A deployment free to add its own methods can
 * add another one that means the same thing ("Supplier terms", "30 days"), and
 * whatever reads "has this been paid" needs a column to ask rather than a
 * hardcoded string to match against a name the owner is free to change.
 *
 * `is_on_account` is that column: whether choosing this method means the money
 * has not left yet. Chosen once, when the method is created, and not editable
 * afterwards -- exactly `vendor_types.is_subcontractor`'s asymmetry, and for
 * the same reason. Renaming "On account" to "Store credit" must not silently
 * flip every past and future expense recorded against it between "paid" and
 * "not yet paid"; a method whose answer was chosen wrongly is retired and
 * replaced, not corrected in place.
 *
 * Nothing reads this column today. No payable, aging or cash-flow view exists
 * yet in this codebase, so `is_on_account` is currently the fact the option
 * text asserts and nothing more -- but it is the fact, stated once, in the one
 * place future code can ask it instead of pattern-matching a name.
 */
export const paymentMethods = pgTable('payment_methods', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** What the owner calls this method. Shown, never matched on. */
  name: text('name').notNull(),
  /**
   * Whether choosing this method means the money has not left yet.
   *
   * Decided once, at creation, and never editable after -- see the note above.
   * False by default: the safe error is a method that is actually a form of
   * "not yet paid" being counted as settled, which reads oddly on a receipt but
   * costs nothing; the unsafe error is money that was never paid being counted
   * as spent, which is the wrong direction for a payables figure to be wrong
   * in. "Account" is seeded with this true and every ordinary instrument --
   * cash, debit, credit, cheque, e-transfer -- with it false.
   */
  isOnAccount: boolean('is_on_account').notNull().default(false),
  /** Where it sits in the picker. Ties fall back to the name. */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * "Do not offer this on new expenses." Retiring, not deletion or voiding.
   *
   * A retired method still resolves for every expense already recorded
   * against it, and still answers whether that expense was on account.
   */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  /**
   * One method, one row, regardless of capitalisation -- on the column and not
   * on the live rows, matching every other maintained list: a partial index
   * would free the name the moment a row was retired, and the next person
   * would create the duplicate the list exists to prevent.
   */
  uniqueIndex('payment_methods_name_unique').on(sql`lower(${t.name})`),
]);
