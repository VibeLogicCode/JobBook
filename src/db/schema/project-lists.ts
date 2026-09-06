import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';

/**
 * Two more maintained lists, for the same reason `trades` and `vendor_types`
 * were converted (`db/schema/vendor-lists.ts`): `project_type` and
 * `lead_source` used to be hardcoded Postgres enums, so adding "Deck" or
 * "HomeStars" needed a migration and a deploy. The owner caught the pattern a
 * third time; this file is the same fix applied twice more.
 *
 * Both mirror `trades` column for column -- a name, an order, a retirement
 * flag, and nothing else. Neither carries a derived rule the way
 * `vendor_types.is_subcontractor` does, so there is no asymmetry to design
 * around here: adding a row is free, in both directions.
 */

/**
 * What kind of work a project is: custom home, basement, kitchen, and so on.
 *
 * Read by `projects`, `scope_templates` and `schedule_templates`, all
 * `NOT NULL` -- a project cannot exist with no type any more than it could
 * when this was an enum. Migration 0018 promoted the nine enum members into
 * rows of this table, `'other'` included: it is a real catch-all a project can
 * genuinely be filed under, not a placeholder to prune.
 */
export const projectTypes = pgTable('project_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** What the owner calls this kind of work. Shown, never matched on. */
  name: text('name').notNull(),
  /** Where it sits in the picker. Ties fall back to the name. */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * "Do not offer this on new work." Retiring, not deletion or voiding.
   *
   * A retired type still resolves for every project, scope template and
   * schedule template already filed under it -- a job already built as a
   * "Water leak" repair must go on reading that on its own record even after
   * the owner stops offering it to new ones.
   */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  /**
   * One type, one row, regardless of capitalisation -- on the column and not
   * on the live rows, for the reason the cost code list gives: a partial
   * index would free the name the moment a row was retired, and the next
   * person would create the duplicate the list exists to prevent.
   */
  uniqueIndex('project_types_name_unique').on(sql`lower(${t.name})`),
]);

/**
 * How a customer found this company: a phone call, a referral, a repeat
 * customer, and so on.
 *
 * Read by `customers.lead_source_id`, which stays nullable -- unlike a
 * project's type, not knowing how somebody heard about the company is a real
 * and common state, not a gap to force shut.
 */
export const leadSources = pgTable('lead_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  /** A source the owner no longer tracks going forward. Every customer already carrying it keeps it. */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  uniqueIndex('lead_sources_name_unique').on(sql`lower(${t.name})`),
]);
