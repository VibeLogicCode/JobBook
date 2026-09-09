import { sql } from 'drizzle-orm';
import { boolean, check, date, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, rate } from '@/db/columns';
import { areaUnitEnum, filingFrequencyEnum, loginMethodEnum, roleEnum } from '@/db/enums';
import { companies } from '@/db/schema/companies';

/**
 * Single-row tenant configuration. Every company-specific string in the product
 * lives here; nothing is hardcoded (spec section 2.1).
 */
export const organization = pgTable('organization', {
  id: integer('id').primaryKey(),

  /**
   * The DEPLOYMENT's label, and the only name that stays here.
   *
   * Three places need a name with no company in hand and no way to get one:
   * the sign-in heading (`app/auth/sign-in/page.tsx`, which renders before
   * authentication, so it has no session and no project), the browser tab
   * title template and the shell heading. A screen that cannot know which
   * company it is must not be asking, so this answers there -- the group's
   * name, when there are two.
   *
   * It must NEVER print on a document. `companies.display_name` and
   * `companies.legal_name` are what appear on paper; this is what appears in
   * the browser.
   */
  displayName: text('display_name').notNull(),

  // ---------------------------------------------------------------------
  // What is left after the split, and why exactly these
  // ---------------------------------------------------------------------
  //
  // Two companies sharing one office cannot disagree about any of the
  // following without one of them being wrong. Everything that IS a fact
  // about a legal person -- the legal name, the address, the HST
  // registration number, the holdback terms, the payment terms, the quote
  // footer -- moved to `companies` in migration 0025.
  //
  // `tenantYear` (lib/quote/numbering.ts), `tenantToday` (lib/quote/dates.ts)
  // and the reminder evaluation (lib/reminders/repository.ts) all read the
  // timezone from here and are deliberately unchanged: what day it is is a
  // property of the office, not of which corporation is billing.

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
  /**
   * What a kilometre driven on a job costs, in ten-thousandths of a currency
   * unit: $0.7200/km is 7200.
   *
   * Configuration and not a constant in code, because the allowance is a
   * jurisdiction's figure and it moves most years. The default is a starting
   * point rather than an authority -- an owner confirms it against whatever
   * his own tax authority publishes, and the settings screen says so.
   *
   * Read ONCE, when a mileage row is written, and copied onto that row
   * (`expenses.rate_per_km_ten_thou`). Nothing reads it back to display or
   * re-cost an existing trip: this column is what the NEXT trip will cost, and
   * a screen that read it live would restate every trip ever driven the first
   * January the figure changed.
   *
   * A deployment fact rather than a company one: it is what the vehicle in
   * the yard costs to run, and both companies drive it.
   */
  mileageRatePerKmTenThou: rate('mileage_rate_per_km_ten_thou').notNull().default(sql`7200`),

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
  /**
   * Whose registration this rate is charged under.
   *
   * NOT NULL, and the single most consequential column in the two-companies
   * change. Before it existed, `loadTaxRatesFor` returned every active rate
   * with no filter and `computeTaxes` applied all of them that were in force
   * -- so the day a second company's 13% HST row existed, EVERY quote in the
   * deployment would have charged 26%. Silently, on a document a customer
   * signs, with the arithmetic entirely innocent.
   *
   * Nothing downstream can be made to catch that, and nothing downstream
   * should try: two rates in force together is legitimate and is why
   * `isCompound` exists -- GST beside PST, Quebec stacking one on the other.
   * A second province's tax and a second corporation's copy of the same tax
   * are indistinguishable once they are both in the list. The filter has to be
   * in the query.
   */
  companyId: uuid('company_id').notNull().references(() => companies.id),
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
  /**
   * Whose series this is. Part of the PRIMARY KEY rather than an extra column,
   * because the key IS the series identity and `allocateDocumentNumber`'s
   * `ON CONFLICT` targets it.
   *
   * Company one keeps its history and company two starts at 0001. Nothing is
   * ever renumbered -- an auditor asks each registrant for its own sequential
   * series, and the existing principle that a gap is the record of a voided
   * document stays true per company.
   */
  companyId: uuid('company_id').notNull().references(() => companies.id),
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
}, (t) => [
  primaryKey({ columns: [t.companyId, t.kind, t.year] }),
  /**
   * The global unique indexes on `invoice_number` and `project_number` stay,
   * so global uniqueness now has to hold BY CONSTRUCTION: two companies both
   * registering `INV` for the same kind and year would format two documents
   * with the same number and the second insert would fail on an index a long
   * way from here. Refused at the source instead.
   */
  uniqueIndex('document_sequences_kind_year_prefix_unique').on(t.kind, t.year, t.prefix),
]);

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
