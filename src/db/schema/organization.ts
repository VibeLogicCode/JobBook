import { sql } from 'drizzle-orm';
import { boolean, check, date, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, rate } from '@/db/columns';
import { areaUnitEnum, filingFrequencyEnum, loginMethodEnum, roleEnum } from '@/db/enums';

/**
 * Single-row tenant configuration. Every company-specific string in the product
 * lives here; nothing is hardcoded (spec section 2.1).
 */
export const organization = pgTable('organization', {
  id: integer('id').primaryKey(),

  // identity
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  operatingName: text('operating_name'),
  tagline: text('tagline'),
  ownerName: text('owner_name'),
  ownerTitle: text('owner_title'),
  logoFileId: uuid('logo_file_id'),
  faviconFileId: uuid('favicon_file_id'),
  brandColor: text('brand_color'),

  // contact
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  province: text('province'),
  postalCode: text('postal_code'),
  country: text('country'),
  phone: text('phone'),
  altPhone: text('alt_phone'),
  email: text('email'),
  website: text('website'),

  // locale
  currency: text('currency').notNull().default('CAD'),
  locale: text('locale').notNull().default('en-CA'),
  /**
   * IANA zone, and not optional. Quote date defaults, valid_until, fiscal
   * period boundaries, cron schedules and days-in-stage all need the tenant's
   * local day; `new Date()` in a UTC container gives the wrong date after 7pm
   * Toronto.
   */
  timezone: text('timezone').notNull().default('America/Toronto'),
  areaUnit: areaUnitEnum('area_unit').notNull().default('sqft'),

  // financial and legal
  taxRegistrationNumber: text('tax_registration_number'),
  /** What the number is called on a document: 'HST Number', 'VAT Number'. */
  taxRegistrationLabel: text('tax_registration_label'),
  businessNumber: text('business_number'),
  /** Not assumed to be 31 December. */
  fiscalYearEndMonth: integer('fiscal_year_end_month'),
  fiscalYearEndDay: integer('fiscal_year_end_day'),
  taxFilingFrequency: filingFrequencyEnum('tax_filing_frequency'),
  /** Excise Tax Act s.168(7): tax on a statutory holdback defers until payable. */
  taxDeferredOnHoldback: boolean('tax_deferred_on_holdback').notNull().default(true),
  defaultHoldbackPctTenThou: rate('default_holdback_pct_ten_thou'),
  holdbackLabel: text('holdback_label'),
  holdbackTermsText: text('holdback_terms_text'),
  holdbackReleaseDays: integer('holdback_release_days').notNull().default(60),
  paymentTermsDays: integer('payment_terms_days'),
  paymentTermsText: text('payment_terms_text'),
  insuranceStatement: text('insurance_statement'),
  /** Drives the worksheet margin gauge bands. */
  targetMarginBp: integer('target_margin_bp'),

  // documents
  quoteValidityDays: integer('quote_validity_days').notNull().default(30),
  quoteTermsText: text('quote_terms_text'),
  documentFooterText: text('document_footer_text'),

  ...auditColumns,
}, (t) => [
  // Single tenancy enforced by the database, not by convention.
  check('organization_single_row', sql`${t.id} = 1`),
]);

/**
 * Tax rates, versioned by effective date rather than edited in place.
 *
 * An edit closes the current row and inserts a new one, so the rate that
 * applied on any past date stays answerable. This works with, not instead of,
 * the per-quote snapshot in quote_taxes.
 */
export const taxRates = pgTable('tax_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  shortLabel: text('short_label'),
  registrationNumber: text('registration_number'),
  rateTenThou: rate('rate_ten_thou').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  /** Null means currently in force. */
  effectiveTo: date('effective_to'),
  /** Applies on the subtotal plus taxes already accumulated. Quebec QST, once. */
  isCompound: boolean('is_compound').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
});

/**
 * Keyed on email, for the ROW's identity: it is the field an administrator
 * types and the field that is UNIQUE. Authentication is a different matter --
 * after a first successful sign-in it keys on the provider's stable subject in
 * `user_identities`, because an email address changes, goes unverified, and
 * with Apple is sometimes a relay.
 *
 * Deactivated via `isActive`, never voided: `email` is UNIQUE, so a voided row
 * would permanently block re-adding the same person.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: roleEnum('role').notNull(),
  /**
   * The administrator's CHOICE of how this person signs in. NULL means no
   * method has been chosen, and in `sso` mode such a user cannot sign in.
   * WHICH account actually linked is recorded in user_identities, not here.
   */
  loginMethod: loginMethodEnum('login_method'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [uniqueIndex('users_email_unique').on(t.email)]);

/**
 * Document numbering, allocated with INSERT ... ON CONFLICT DO UPDATE
 * ... RETURNING so two concurrent allocations cannot collide.
 *
 * Replaces six per-document sequence columns on `organization`, which did not
 * extend to change orders or purchase orders, and where an earlier draft had
 * project numbers incrementing the invoice counter.
 */
export const documentSequences = pgTable('document_sequences', {
  kind: text('kind').notNull(),
  year: integer('year').notNull(),
  nextSeq: integer('next_seq').notNull().default(1),
  /**
   * Document code, per kind and per year: 'QT', 'CO', 'INV', 'PO'.
   *
   * Here rather than on `organization` because that is what the six removed
   * counter columns were, and because a tenant that renames its quotes
   * mid-year keeps the old year's numbers intact.
   */
  prefix: text('prefix'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.kind, t.year] })]);

/**
 * Key/value machine state: update bookkeeping, sync cursors. NOT mirrored.
 *
 * Distinct from `organization`, which holds typed tenant configuration.
 * Absence is the off state, so no defaulted column can switch a feature on for
 * someone who never asked. There is deliberately no feature_flags table --
 * flags and credentials are environment variables, because a mirrored table
 * ends up in SharePoint and in every backup, and secrets must never enter the
 * database.
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
