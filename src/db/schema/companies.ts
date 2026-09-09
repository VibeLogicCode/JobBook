import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, rate } from '@/db/columns';
import { filingFrequencyEnum, workPostureEnum } from '@/db/enums';

/**
 * The legal person whose name is on the paper.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A SECOND `organization` ROW
 * ---------------------------------------------------------------------------
 *
 * The cheaper-looking variant is to drop `organization`'s single-row CHECK and
 * treat each row as a company. It is wrong twice: it puts `timezone` and
 * `currency` on two rows that must agree -- two companies sharing one office
 * cannot disagree about what today's date is without one of them being wrong
 * -- and it inherits the integer primary key, which `files.entity_id` (a uuid,
 * per `db/schema/system.ts`) cannot point at. Two companies need two logos.
 *
 * So: `organization` stays the DEPLOYMENT and keeps its check. This table is
 * the ISSUER, and holds exactly what is a fact about a legal person or appears
 * on its letterhead.
 *
 * ---------------------------------------------------------------------------
 * WHY `companies` AND NEVER `entities`
 * ---------------------------------------------------------------------------
 *
 * `files.entity_type` / `entity_id` already exists and already means "which
 * record does this file attach to" -- a quote, a project, an expense. Two
 * meanings for one word in one schema is how a query gets written against the
 * wrong thing and passes review.
 *
 * ---------------------------------------------------------------------------
 * `displayName` IS ON BOTH TABLES, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * Not an oversight and not duplication to clean up later. `organization`
 * keeps its own `displayName` as the DEPLOYMENT's label, because three places
 * need a name with no company in hand and cannot get one: the sign-in heading
 * (`app/auth/sign-in/page.tsx`, which renders before authentication, so it has
 * no session, no project and no way to choose between two companies), the
 * browser tab title template and the shell heading.
 *
 * A screen that cannot know which company it is must not be asking. So the
 * deployment's name answers there -- the group's name, when there are two --
 * and THIS column is what prints on a document.
 *
 * ---------------------------------------------------------------------------
 * RETIRED, NEVER DELETED
 * ---------------------------------------------------------------------------
 *
 * `isActive` is how two companies merge back into one: mark the second
 * inactive, no new jobs may be filed under it, and every document it already
 * issued keeps the letterhead it was legally issued under. Deleting the row
 * would rewrite history on documents a customer holds and an auditor may ask
 * for.
 */
export const companies = pgTable('companies', {
  id: uuid('id').primaryKey().defaultRandom(),

  // identity and branding
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

  /**
   * The Input Tax Credit Information Regulations require the SUPPLIER's own
   * registration number on invoices of $30 and up. The wrong number makes the
   * customer's credit defective and reports the supply under the wrong
   * account, so this cannot be a deployment-wide value once two registrants
   * exist.
   */
  taxRegistrationNumber: text('tax_registration_number'),
  taxRegistrationLabel: text('tax_registration_label'),
  businessNumber: text('business_number'),
  fiscalYearEndMonth: integer('fiscal_year_end_month'),
  fiscalYearEndDay: integer('fiscal_year_end_day'),
  taxFilingFrequency: filingFrequencyEnum('tax_filing_frequency'),

  // holdback
  taxDeferredOnHoldback: boolean('tax_deferred_on_holdback').notNull().default(true),
  defaultHoldbackPctTenThou: rate('default_holdback_pct_ten_thou'),
  holdbackLabel: text('holdback_label'),
  holdbackTermsText: text('holdback_terms_text'),
  holdbackReleaseDays: integer('holdback_release_days').notNull().default(60),

  // terms
  /**
   * NULLABLE, matching `organization` -- deliberately not defaulted to 30.
   *
   * `issueInvoice` reads this to compute a due date and writes null when it is
   * null: "no stated terms" is a real position, and a default would invent a
   * due date the customer never agreed to. That is the same class of error as
   * a holdback percentage nobody asked for.
   */
  paymentTermsDays: integer('payment_terms_days'),
  paymentTermsText: text('payment_terms_text'),
  insuranceStatement: text('insurance_statement'),
  targetMarginBp: integer('target_margin_bp'),

  // documents
  quoteValidityDays: integer('quote_validity_days').notNull().default(30),
  quoteTermsText: text('quote_terms_text'),
  documentFooterText: text('document_footer_text'),

  /**
   * What kind of work this company does: service, contract, or both.
   *
   * Here rather than on `organization` because it is the thing that makes two
   * companies two DIFFERENT businesses rather than two letterheads -- the
   * owner's repair company does service work and his building company does
   * contract work, which is why he asked for both features at once.
   *
   * `both` is today's behaviour, so it is the default and adding this column
   * changes nothing. Read through `lib/posture/read.ts`, never compared
   * inline: it FAILS OPEN, and a call site that compares the string itself
   * would not.
   */
  workPosture: workPostureEnum('work_posture').notNull().default('both'),

  /**
   * What distinguishes this company's document numbers from the other's.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS COLUMN HAS TO EXIST
   * ---------------------------------------------------------------------------
   *
   * Each company runs its OWN series -- company one keeps its history and
   * company two starts at 0001, which is what an auditor asks each registrant
   * for. But `quotes.quote_number`, `customer_invoices.invoice_number` and
   * `projects.project_number` are globally unique indexes, and those documents
   * carry no company of their own: they reach one through their project. So
   * two companies both numbering `INV-2026-0001` would collide on an index a
   * long way from the cause.
   *
   * The prefix is therefore what has to differ, and `document_sequences` has a
   * unique index on `(kind, year, prefix)` to refuse the clash at the source
   * rather than let it surface as a failed insert on an invoice.
   *
   * So this is appended to the per-kind code: null or empty leaves company one
   * issuing `INV-2026-0001` exactly as before, and a second company set to `S`
   * issues `INVS-2026-0001`. Per KIND as well as per company, deliberately --
   * one flat per-company prefix would make a quote and a change order both
   * `NHS-2026-0001`, and they share `quotes.quote_number`.
   *
   * A person can also tell the two apart at a glance, which is worth more than
   * the column costs.
   */
  documentCodeSuffix: text('document_code_suffix'),

  /** Where it sits in the picker. Ties fall back to the display name. */
  sortOrder: integer('sort_order').notNull().default(0),
  /**
   * "No new jobs under this company." Retiring, not deletion -- see the
   * header. Every document it issued stays readable and stays attributed.
   */
  isActive: boolean('is_active').notNull().default(true),

  ...auditColumns,
});
