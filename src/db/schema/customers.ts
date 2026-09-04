import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';
import {
  contractTypeEnum, customerTypeEnum, leadSourceEnum, projectStageEnum, projectTypeEnum,
} from '@/db/enums';

export const customers = pgTable('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  companyName: text('company_name'),
  email: text('email'),
  phone: text('phone'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  /**
   * No default. Defaulting this to 'ON' in the schema would hardcode a tenant's
   * region (spec 2.1); the UI defaults it from organization.province instead.
   */
  province: text('province'),
  postalCode: text('postal_code'),
  /** A spouse, a property manager, a site contact -- whoever also gets called. */
  altContactName: text('alt_contact_name'),
  altContactEmail: text('alt_contact_email'),
  altContactPhone: text('alt_contact_phone'),
  customerType: customerTypeEnum('customer_type').notNull(),
  leadSource: leadSourceEnum('lead_source'),
  // Exemption is stored with its number and reason: the number belongs on the
  // document, and an unexplained exemption is an audit gap.
  isTaxExempt: boolean('is_tax_exempt').notNull().default(false),
  taxExemptNumber: text('tax_exempt_number'),
  taxExemptReason: text('tax_exempt_reason'),
  notes: text('notes'),
  ...auditColumns,
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id),
  projectNumber: text('project_number').notNull(),
  name: text('name').notNull(),
  siteAddressLine1: text('site_address_line1'),
  siteCity: text('site_city'),
  siteProvince: text('site_province'),
  sitePostalCode: text('site_postal_code'),
  projectType: projectTypeEnum('project_type').notNull(),
  contractType: contractTypeEnum('contract_type'),
  stage: projectStageEnum('stage').notNull().default('lead'),
  // Scheduled and actual are separate columns so slippage stays measurable
  // rather than being overwritten by the date the job really started.
  scheduledStart: date('scheduled_start'),
  scheduledEnd: date('scheduled_end'),
  actualStart: date('actual_start'),
  actualEnd: date('actual_end'),
  /** Starts the holdback release clock under the Construction Act. */
  substantialPerformanceDate: date('substantial_performance_date'),
  /** The statutory clock runs from publication, not from the date certified. */
  certificatePublishedDate: date('certificate_published_date'),
  lostReason: text('lost_reason'),
  notes: text('notes'),
  // No contract_value column. Contract value is DERIVED as the sum of accepted
  // quotes on the project (spec 5.6); storing it too would give two sources of
  // truth from day one.
  ...auditColumns,
}, (t) => [uniqueIndex('projects_number_unique').on(t.projectNumber)]);

/**
 * Trigger-populated stage transitions. Time in stage is derived from these
 * rows, never stored: a stored duration is stale the moment the clock moves.
 */
export const stageHistory = pgTable('stage_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  /** Null on the row that records a project's first stage. */
  fromStage: projectStageEnum('from_stage'),
  toStage: projectStageEnum('to_stage').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  changedBy: uuid('changed_by'),
  note: text('note'),
  ...auditColumns,
}, (t) => [index('stage_history_project_idx').on(t.projectId, t.changedAt)]);

/**
 * Cost code hierarchy: division, then section. Exists in Phase 1 because quote
 * lines snapshot a cost code, and without it Phase 3 job costing has nothing to
 * group actual spend against.
 */
export const costCodes = pgTable('cost_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  parentId: uuid('parent_id').references((): AnyPgColumn => costCodes.id),
  category: text('category'),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [uniqueIndex('cost_codes_code_unique').on(t.code)]);
