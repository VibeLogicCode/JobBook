import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';

/**
 * The two lists the vendor form picks from: what KIND of counterparty this is,
 * and -- when that kind performs work -- what kind of subcontractor.
 *
 * Both were free text or a checkbox before, and the owner asked for both to
 * become lists he maintains. The interesting part is not that they are lists;
 * it is where the line between "data he owns" and "a rule he must not be able
 * to retype" falls, because `vendors.is_subcontractor` is not a label.
 *
 * Three things and nothing else turn on that column: who receives a T5018
 * statement of contract payments, who needs a current WSIB clearance
 * certificate before a cheque is written, and who may be assigned to a
 * scheduled task. Paying a subcontractor whose clearance has lapsed transfers
 * liability for their premiums to the general contractor, which is a real bill
 * and not a reporting nuisance.
 *
 * So the list is maintainable and the RULE is not. `vendor_types` is a table
 * the owner adds rows to freely -- equipment rental, professional services,
 * whatever his next job needs -- and each row carries `is_subcontractor` as a
 * flag chosen once, when the row is created, and never editable afterwards.
 * That asymmetry is the whole design:
 *
 * - Renaming a type relabels it. "Material supplier" becoming "Suppliers"
 *   reaches every vendor filed under it and changes nothing about who is owed
 *   a slip.
 * - Retiring a type stops it being offered on new vendors and changes nothing
 *   about the vendors already on it.
 * - Nothing an owner can type changes whether an existing vendor counts as a
 *   subcontractor. Only moving that vendor to a different type does, which is
 *   a deliberate act on the vendor's own form with the consequence written
 *   beside it.
 *
 * If the flag were editable, retitling one row would silently restate the tax
 * and insurance standing of every vendor under it -- and nothing on any screen
 * would say so, because nothing about the vendor changed. The remedy for a
 * flag chosen wrongly is the same one the cost code list gives for a code that
 * now means a different trade: retire that row and add the right one.
 */

/**
 * What kind of counterparty a vendor is.
 *
 * Seeded generically (`src/db/seed/vendor-lists.ts`) and extended by the
 * tenant. Nothing in the product matches on a type's NAME -- the flag is what
 * is read -- so a deployment that calls its subcontractors something else
 * works identically.
 */
export const vendorTypes = pgTable('vendor_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** What the owner calls this kind of counterparty. Shown, never matched on. */
  name: text('name').notNull(),
  /**
   * Whether vendors of this type perform work rather than selling goods.
   *
   * Chosen when the row is created and not editable afterwards -- see the note
   * at the top of this file. `vendors.is_subcontractor` is derived from this
   * column by trigger, so this is the only place the answer is decided and the
   * only place it can be got wrong.
   *
   * False by default, because the safe error is leaving a sub off the
   * assignment picker -- which somebody notices the same afternoon -- rather
   * than filing a T5018 for a building supply store.
   */
  isSubcontractor: boolean('is_subcontractor').notNull().default(false),
  /** Where it sits in the picker. Ties fall back to the name. */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * "Do not offer this on new vendors." Retiring, and not deletion or voiding.
   *
   * A retired type still resolves for every vendor already filed under it, and
   * still decides whether those vendors are subcontractors. Retiring
   * "Equipment rental" must not blank the vendors on it, and must certainly not
   * quietly move anybody onto or off a T5018.
   */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  /**
   * One type, one row, regardless of capitalisation -- on the column and not
   * on the live rows, for the reason the cost code list gives: a partial index
   * would free the name the moment a row was retired, and the next person
   * would create the duplicate the list exists to prevent. The refusal says
   * which row holds the name and whether it is retired or void.
   */
  uniqueIndex('vendor_types_name_unique').on(sql`lower(${t.name})`),
]);

/**
 * What kind of subcontractor somebody is: framing, electrical, drywall.
 *
 * Deliberately NOT the cost code list and deliberately not a work-breakdown
 * vocabulary. A trade is what you call somebody when you are looking for one;
 * a cost code is how their invoice is categorised. They correlate and are not
 * the same, and one electrician's work lands on two codes.
 *
 * Asked only of a vendor whose type carries `is_subcontractor`. A lumber yard
 * has no trade, and asking it for one was the thing the owner objected to.
 */
export const trades = pgTable('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * A trade the company no longer hires. The subcontractors already carrying
   * it go on carrying it and go on displaying it -- retiring is a statement
   * about new work, and a roofer whose trade blanked would read as a data loss.
   */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  uniqueIndex('trades_name_unique').on(sql`lower(${t.name})`),
]);
