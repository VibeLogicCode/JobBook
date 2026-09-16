import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, cents, qty, rate } from '@/db/columns';
import {
  calcModeEnum, changeReasonEnum, clauseKindEnum, pricingDisplayEnum, quoteKindEnum,
  quoteStatusEnum,
} from '@/db/enums';
import { costCodes, projects } from '@/db/schema/customers';
import { rateItems, scopeTemplates } from '@/db/schema/rates';

/**
 * A quote, and also a change order.
 *
 * A change order IS a quote with a parent: same lines, same taxes, same
 * engine, same PDF with a different heading, same versioning and acceptance.
 * Three parallel change_order tables would duplicate all of it and push
 * mid-job extras out to Phase 4. Deductive change orders use negative rates.
 */
export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  quoteNumber: text('quote_number').notNull(),
  kind: quoteKindEnum('kind').notNull().default('estimate'),
  /** The estimate a change order amends. */
  parentQuoteId: uuid('parent_quote_id').references((): AnyPgColumn => quotes.id),
  /** Change order number within the project. Estimates sit at 1. */
  sequence: integer('sequence').notNull().default(1),
  reason: changeReasonEnum('reason'),
  /** Unpriced time is still a cost, so a delay is recorded even at zero dollars. */
  scheduleImpactDays: integer('schedule_impact_days'),
  version: integer('version').notNull().default(1),
  status: quoteStatusEnum('status').notNull().default('draft'),
  quoteDate: date('quote_date').notNull(),
  validUntil: date('valid_until').notNull(),
  /** So "regenerate" knows what to regenerate from. */
  scopeTemplateId: uuid('scope_template_id').references(() => scopeTemplates.id),

  // Scope inputs are retained so a quote can be explained and regenerated.
  areaSqftMilli: qty('area_sqft_milli'),
  washroomCount: integer('washroom_count'),
  kitchenCount: integer('kitchen_count'),
  bedroomCount: integer('bedroom_count'),

  subtotalCents: cents('subtotal_cents').notNull().default(0),
  taxTotalCents: cents('tax_total_cents').notNull().default(0),
  totalCents: cents('total_cents').notNull().default(0),
  totalCostCents: cents('total_cost_cents').notNull().default(0),
  marginBp: integer('margin_bp').notNull().default(0),
  /** Per quote and nullable; defaulted from the organization by customer type. */
  holdbackPctTenThou: rate('holdback_pct_ten_thou'),
  pricingDisplay: pricingDisplayEnum('pricing_display').notNull().default('group_totals'),

  exclusionsText: text('exclusions_text'),
  assumptionsText: text('assumptions_text'),
  terms: text('terms'),
  notes: text('notes'),
  internalNotes: text('internal_notes'),
  /** Deposit and draw terms differ per job, so they are not only organization-wide. */
  paymentTermsText: text('payment_terms_text'),
  acceptedByName: text('accepted_by_name'),
  acceptanceFileId: uuid('acceptance_file_id'),

  sentAt: timestamp('sent_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  declinedAt: timestamp('declined_at', { withTimezone: true }),
  pdfPath: text('pdf_path'),
  ...auditColumns,
}, (t) => [
  uniqueIndex('quotes_project_kind_sequence_version_unique')
    .on(t.projectId, t.kind, t.sequence, t.version),
  // At most one accepted version of a given quote may stand at a time. Two
  // would make the project's derived contract value ambiguous, and contract
  // value is derived precisely so it cannot disagree with the quotes behind it.
  uniqueIndex('quotes_one_accepted_per_sequence')
    .on(t.projectId, t.kind, t.sequence)
    .where(sql`status = 'accepted' and record_status = 'active'`),
  index('quotes_number_idx').on(t.quoteNumber),
  /**
   * What `/quotes` actually asks for: the active quotes, newest first. It had
   * no covering index, so every load of the list sorted the whole table.
   */
  index('quotes_list_idx').on(t.recordStatus, t.createdAt.desc()),
  /**
   * The expiry sweep on the same screen -- sent quotes whose validity has
   * passed. Leading with `status` because it is the selective half.
   */
  index('quotes_expiry_idx').on(t.status, t.validUntil),
]);

/**
 * A quote line is an immutable financial record.
 *
 * Code, description, calc mode, unit label and both rates are copies taken at
 * line creation. If lines resolved live rates, raising a rate would silently
 * rewrite the value of every historical quote, including ones already accepted.
 *
 * The snapshot rule is about PRICES, not origin: rateItemId and costCodeId are
 * carried as provenance. An earlier draft asserted no rateItemId existed at
 * all, which made every quote uncostable in Phase 3 and re-pricing at current
 * rates impossible.
 */
export const quoteLines = pgTable('quote_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  sortOrder: integer('sort_order').notNull(),
  lineGroup: text('line_group').notNull(),
  code: text('code').notNull(),
  description: text('description').notNull(),
  calcMode: calcModeEnum('calc_mode').notNull(),
  unitLabel: text('unit_label').notNull(),
  /** Provenance only, never read for pricing. Null for an ad-hoc line. */
  rateItemId: uuid('rate_item_id').references(() => rateItems.id),
  /** Snapshotted; what Phase 3 groups actual cost against. */
  costCodeId: uuid('cost_code_id').references(() => costCodes.id),
  qtyMilli: qty('qty_milli').notNull(),
  unitCostTenThou: rate('unit_cost_ten_thou').notNull(),
  unitPriceTenThou: rate('unit_price_ten_thou').notNull(),
  lineCostCents: cents('line_cost_cents').notNull(),
  lineTotalCents: cents('line_total_cents').notNull(),
  isTaxable: boolean('is_taxable').notNull().default(true),
  isAllowance: boolean('is_allowance').notNull().default(false),
  isOptional: boolean('is_optional').notNull().default(false),
  isIncluded: boolean('is_included').notNull().default(true),
  /** Customer-facing sub-text under the description, not an internal note. */
  notes: text('notes'),
  ...auditColumns,
}, (t) => [
  index('quote_lines_quote_idx').on(t.quoteId, t.sortOrder),
  /**
   * The cost-code usage tally on `/settings/cost-codes` groups by this column
   * over every quote line ever written; without an index that is a sequential
   * scan and a hash aggregate each time the screen opens.
   */
  index('quote_lines_cost_code_idx').on(t.costCodeId),
  // A non-optional excluded line would print as an available upgrade the
  // customer cannot actually buy.
  check('quote_lines_excluded_only_if_optional', sql`${t.isOptional} or ${t.isIncluded}`),
]);

/**
 * Snapshotted tax breakdown, one row per rate.
 *
 * The taxable base is stored beside the rate so a document reconciles years
 * later without re-running the engine against whatever the rates say then.
 */
export const quoteTaxes = pgTable('quote_taxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  quoteId: uuid('quote_id').notNull().references(() => quotes.id),
  label: text('label').notNull(),
  registrationNumber: text('registration_number'),
  rateTenThou: rate('rate_ten_thou').notNull(),
  taxableBaseCents: cents('taxable_base_cents').notNull(),
  taxAmountCents: cents('tax_amount_cents').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
}, (t) => [index('quote_taxes_quote_idx').on(t.quoteId, t.sortOrder)]);

/** Reusable exclusion and assumption library, so wording stays consistent. */
export const quoteClauses = pgTable('quote_clauses', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: clauseKindEnum('kind').notNull(),
  clauseText: text('text').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
});
