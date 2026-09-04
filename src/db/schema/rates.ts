import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, qty, rate } from '@/db/columns';
import { calcModeEnum, projectTypeEnum, qtySourceEnum } from '@/db/enums';
import { costCodes } from '@/db/schema/customers';

/**
 * The priced item list. ONE list per deployment -- there is deliberately no
 * rate_cards table: multiple cards would mean recreating every template
 * against new item rows, and snapshotting already protects historical quotes.
 *
 * Cost and sell are both stored so the worksheet can show live margin while
 * the owner edits, and so a quote drifting toward a loss is visible before it
 * is sent. Cost never appears on a customer document.
 */
export const rateItems = pgTable('rate_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  description: text('description').notNull(),
  costCodeId: uuid('cost_code_id').references(() => costCodes.id),
  calcMode: calcModeEnum('calc_mode').notNull(),
  /** 'sqft', 'lnft', 'ea', 'hr', 'm2'. Display only; never affects arithmetic. */
  unitLabel: text('unit_label').notNull(),
  costRateTenThou: rate('cost_rate_ten_thou').notNull(),
  /** May be negative: a discount line, or a deductive change order. */
  sellRateTenThou: rate('sell_rate_ten_thou').notNull(),
  /** False for pass-through disbursements such as a municipal permit fee. */
  isTaxable: boolean('is_taxable').notNull().default(true),
  /** A customer-spendable placeholder, reconciled against actual cost later. */
  isAllowance: boolean('is_allowance').notNull().default(false),
  defaultQtyMilli: qty('default_qty_milli'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [uniqueIndex('rate_items_code_unique').on(t.code)]);

export const scopeTemplates = pgTable('scope_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  projectType: projectTypeEnum('project_type').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
});

/**
 * Quantity derives as `source value x multiplier`.
 *
 * An expression evaluator was considered and rejected: a user-editable formula
 * language stored in a database column is an injection surface and an unbounded
 * support burden. The enum covers every case described and extends cheaply.
 */
export const scopeTemplateItems = pgTable('scope_template_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  scopeTemplateId: uuid('scope_template_id').notNull().references(() => scopeTemplates.id),
  rateItemId: uuid('rate_item_id').notNull().references(() => rateItems.id),
  qtySource: qtySourceEnum('qty_source').notNull(),
  /** 1 is 10000n; one pot light per 50 sqft is 200n. */
  // A bigint literal default cannot be serialized by drizzle-kit, so the
  // default is expressed as SQL. 10000 is a multiplier of exactly 1.
  qtyMultiplierTenThou: rate('qty_multiplier_ten_thou').notNull().default(sql`10000`),
  fixedQtyMilli: qty('fixed_qty_milli'),
  /** An optional item starts excluded, so a template cannot silently inflate a quote. */
  isOptional: boolean('is_optional').notNull().default(false),
  /**
   * Overrides the rate item's own flag, so one item can be a fixed price in one
   * template and an allowance in another.
   */
  isAllowance: boolean('is_allowance').notNull().default(false),
  lineGroup: text('line_group').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
});
