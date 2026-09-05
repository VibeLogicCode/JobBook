import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';

/**
 * The section heading a quote line is filed under -- General, Framing,
 * Drywall, and so on. It is what prints on the customer's document to band the
 * worksheet, which is a different job from a cost code: a cost code is how the
 * OWNER'S spend is categorised, and a line group is how the CUSTOMER reads the
 * page.
 *
 * `scope_template_items.line_group`, `quote_lines.line_group` and
 * `customer_invoice_lines.line_group` stay free text for now -- converting
 * them to point at this table is a later, separate decision with migration
 * risk against live quotes, and nothing here changes that. What this table
 * fixes is the one failure a free-text heading invites: "Flooring" typed on
 * one line and "flooring" on another prints as two sections with the same
 * name in front of a customer, because nothing forced the second typing to
 * match the first. A maintained list is somewhere to copy the heading FROM.
 *
 * Retiring, renaming and voiding all follow `trades` exactly, for the reason
 * `db/schema/vendor-lists.ts` gives for holding that pair to one shape: two
 * near-identical lists drift when each is free to invent its own rules for the
 * same three questions, and a name typed twice is the failure this repository
 * has already paid for once.
 */
export const lineGroups = pgTable('line_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** What prints on the quote. Shown, never matched on by anything downstream. */
  name: text('name').notNull(),
  /** Where it sits in the picker, and the band order on a printed worksheet. */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * "Do not offer this on a new line." Retiring, and not deletion or voiding.
   *
   * Nothing today points at this row by id -- the columns it will eventually
   * back are still text -- so retiring changes only what the picker offers,
   * once that wiring exists. No document is affected either way.
   */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  /**
   * One heading, one row, regardless of capitalisation -- on the column and
   * not on the live rows, for the reason the trade list gives: a partial index
   * would free the name the moment a row was retired, and the next person
   * would recreate the duplicate this table exists to prevent.
   */
  uniqueIndex('line_groups_name_unique').on(sql`lower(${t.name})`),
]);
