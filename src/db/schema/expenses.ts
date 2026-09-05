import { sql } from 'drizzle-orm';
import {
  boolean, check, date, index, integer, jsonb, numeric, pgTable, text, uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, cents, qty, rate } from '@/db/columns';
import {
  expenseKindEnum, expenseSourceEnum, expenseStatusEnum, paymentMethodEnum,
} from '@/db/enums';
import { costCodes, projects } from '@/db/schema/customers';
import { customerInvoices } from '@/db/schema/invoices';
import { files } from '@/db/schema/system';
import { vendors } from '@/db/schema/vendors';

/**
 * What a job cost: the lumber, the sub's invoice, the dump run, the driving
 * (spec 3.2, plus the mileage columns the job-costs plan adds).
 *
 * This is the table that kills the shoebox. Every dollar spent lands against a
 * project and a cost code on the day it is spent, so a year end is an export
 * rather than an archaeology project -- and the margin on a job stops being a
 * guess the owner makes in the truck.
 *
 * **One table, two kinds.** A purchase is money paid to a vendor and evidenced
 * by a receipt. A mileage entry is distance driven, costed at a per-kilometre
 * rate, paid to nobody and evidenced by nothing. They are different enough
 * that two tables were the obvious design and wrong: job costing then becomes
 * a union in every query that ever asks what a job cost, forever, and the
 * union nobody remembers to update is the one that under-reports. `kind`
 * carries the difference instead, and the CHECKs below make each shape
 * impossible to write wrong.
 *
 * **Mileage is cost only.** It moves margin and it never appears on a customer
 * document. `is_billable` is forced false on a mileage row by CHECK rather
 * than left to a form, because "bill the customer for my driving" is a
 * decision this product does not make and must not make by accident.
 *
 * **Nothing is deleted.** A miscoded receipt is voided with a reason and
 * re-entered; the application role holds no DELETE privilege at all. A void
 * row leaves every sum, which is what makes voiding a complete substitute.
 */
export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * 'purchase' by default, because that is what almost every row is and a
   * mileage entry is written from a form that says so out loud.
   */
  kind: expenseKindEnum('kind').notNull().default('purchase'),
  /**
   * NOT NULL, and that is the whole point of the table.
   *
   * Spec 3.2 leaves this nullable, for overhead a job cannot be charged with.
   * It is required here because the feature the owner asked for is "expenses
   * to job", and an expense with no job is a row that quietly leaves job
   * costing while still looking recorded. Overhead is a real gap and it is
   * named in the report rather than half-supported by a nullable column: when
   * it arrives it wants its own answer, not a null.
   */
  projectId: uuid('project_id').notNull().references(() => projects.id),
  /**
   * Who was paid. Null on a mileage row, where nobody was.
   *
   * A live reference rather than a copied name, which is the reason `vendors`
   * exists at all: "Dave", "Dave M" and "Dave Masonry" typed into three
   * expense rows is a T5018 total split three ways and short on all of them.
   */
  vendorId: uuid('vendor_id').references(() => vendors.id),
  /**
   * How the spend is categorised, and the column the whole costing view groups
   * by. A live reference, like `quote_lines.cost_code_id`: a retired or voided
   * code goes on resolving, and the screen says which it is.
   */
  costCodeId: uuid('cost_code_id').references(() => costCodes.id),
  /**
   * The date on the receipt, or the day the trip was driven. Never the day it
   * was typed: an owner catching up on six weeks of paper at a kitchen table
   * would otherwise post the whole shoebox into one filing period.
   */
  expenseDate: date('expense_date').notNull(),
  /** What was bought, or what the trip was for. Required: a figure with no words beside it is unreadable a year later. */
  description: text('description').notNull(),
  /** The receipt or invoice number, when the paper carries one. */
  reference: text('reference'),

  /**
   * Money, in integer cents, and SIGNED.
   *
   * Negative is a real figure and not an error: a return, a credit note, a
   * supplier rebate. A receipt typed as `(45.00)` is accounting notation for
   * one, and the parser at the form's edge reads it that way. Refusing
   * negatives would mean the only way to record a return is to not record it.
   */
  subtotalCents: cents('subtotal_cents').notNull().default(0),
  taxTotalCents: cents('tax_total_cents').notNull().default(0),
  totalCents: cents('total_cents').notNull().default(0),

  /** Null on a mileage row: an allowance for driving is not paid by any instrument. */
  paymentMethod: paymentMethodEnum('payment_method'),
  /**
   * The photograph or scan. Null on a mileage row, and the form does not ask.
   *
   * A file row, never a path: `src/lib/files/**` sniffs what the bytes really
   * are and stores them under a UUID derived from that, so nothing a person
   * uploaded ever names a file on disk.
   */
  receiptFileId: uuid('receipt_file_id').references(() => files.id),
  /**
   * The supplier's GST/HST registration, COPIED FROM THE RECEIPT.
   *
   * Deliberately not a join to `vendors.tax_registration_number`, and it must
   * not be quietly turned into one. An input tax credit on a purchase over $30
   * is evidenced against the registration number the supplier printed on the
   * paper that day. A registration can change, lapse, or have been typed into
   * the vendor record wrongly; the claim stands or falls on what the receipt
   * said, so what the receipt said is what is stored.
   */
  vendorTaxNumberCaptured: text('vendor_tax_number_captured'),

  /**
   * Provenance. Created now and written only as 'manual', because the plan's
   * third decision defers reading receipts to a later pass -- and adding this
   * column then would be a migration against a table holding a year of live
   * spend, with nothing to backfill it from.
   */
  source: expenseSourceEnum('source').notNull().default('manual'),
  /** Unused until OCR lands. How sure the recogniser was, 0..1. */
  ocrConfidence: numeric('ocr_confidence'),
  /** Unused until OCR lands. The raw candidate extraction, kept so a bad read can be explained. */
  ocrRaw: jsonb('ocr_raw'),

  /**
   * 'posted' is what a person typing a row writes. See the enum's note: job
   * costing counts posted rows, and a manual row parked short of it is spend
   * the owner entered and the costing view ignored.
   */
  status: expenseStatusEnum('status').notNull().default('captured'),
  /**
   * Whether this cost is to be passed on to the customer -- cost-plus, time
   * and material, or a line inside an allowance reconciliation.
   *
   * False by default, and false by CHECK on a mileage row. The safe error is
   * a cost the owner has to remember to bill; the unsafe one is a customer
   * invoice that grew a line nobody decided on.
   */
  isBillable: boolean('is_billable').notNull().default(false),
  /** Which invoice already passed it on, so it cannot be billed twice. Phase 4 writes it. */
  billedOnInvoiceId: uuid('billed_on_invoice_id').references(() => customerInvoices.id),

  /* ---------------------------------------------------------------------
     Mileage
     --------------------------------------------------------------------- */

  /**
   * Kilometres, in integer thousandths: 42.5 km is 42500n. The same scale
   * every other quantity in the product uses, so nothing has to remember a
   * second one.
   */
  distanceMilli: qty('distance_milli'),
  /**
   * The per-kilometre rate this trip was costed at, SNAPSHOTTED onto the row.
   *
   * This is the single most important column in the table and the easiest to
   * get wrong, because reading `organization.mileage_rate_per_km_ten_thou`
   * live at display time produces a screen that looks right every day until
   * the first January after the allowance changes -- at which point every trip
   * ever driven silently restates itself at the new rate, including the ones
   * in periods already filed. A stored rate is also the only thing that makes
   * the figure defensible if it is ever questioned: it says what the rate was
   * on the day, which is the question actually asked.
   *
   * Exactly the rule a quote line follows in snapshotting its unit price, and
   * for exactly the same reason.
   */
  ratePerKmTenThou: rate('rate_per_km_ten_thou'),

  notes: text('notes'),
  ...auditColumns,
}, (t) => [
  // The one query job costing makes, and the one the project screen makes.
  index('expenses_project_idx').on(t.projectId, t.expenseDate),
  // Everything a vendor was ever paid, which is what a T5018 run and a
  // supplier dispute both start from.
  index('expenses_vendor_idx').on(t.vendorId, t.expenseDate),
  // Grouped by code, across jobs: the "what did concrete cost this year"
  // question the accountant export answers.
  index('expenses_cost_code_idx').on(t.costCodeId),

  // The identity the whole row rests on. Get it wrong and a job's cost is out
  // by the tax on every receipt, which is the error least likely to be spotted
  // by eye because each row still looks plausible.
  check('expenses_total_identity', sql`total_cents = subtotal_cents + tax_total_cents`),

  // Each kind's shape, refused at the last place it still can be. The form
  // does not offer a vendor or a receipt on a mileage entry; this is what makes
  // that a fact rather than a habit of one screen.
  check(
    'expenses_kind_shape',
    sql`case kind
          when 'mileage' then
            vendor_id is null
            and receipt_file_id is null
            and payment_method is null
            and vendor_tax_number_captured is null
            and tax_total_cents = 0
            and is_billable = false
            and distance_milli is not null
            and rate_per_km_ten_thou is not null
          when 'purchase' then
            distance_milli is null
            and rate_per_km_ten_thou is null
        end`,
  ),
  // Nobody drives a negative distance at a negative rate. A credit is a
  // purchase with a negative total, never a trip run backwards.
  check(
    'expenses_mileage_not_negative',
    sql`kind <> 'mileage' or (distance_milli >= 0 and rate_per_km_ten_thou >= 0)`,
  ),
  // The arithmetic, in the database, in the same scale and with the same
  // rounding the application uses: thousandths of a kilometre times
  // ten-thousandths of a currency unit is a scale of 10^7, and cents are 10^2,
  // so the product divides by 10^5. Postgres `round()` on numeric is
  // half-away-from-zero, which is what `divRoundHalfUp` does.
  //
  // Here rather than only in a test because the cost of a mileage row is the
  // one figure on it nobody can check by eye against a piece of paper.
  check(
    'expenses_mileage_cost_identity',
    sql`kind <> 'mileage'
        or subtotal_cents = round(distance_milli::numeric * rate_per_km_ten_thou / 100000)`,
  ),
  // A cost that was never going to be billed cannot have been billed.
  check(
    'expenses_billed_only_when_billable',
    sql`billed_on_invoice_id is null or is_billable`,
  ),
]);

/**
 * The tax on one receipt, broken out one row per tax.
 *
 * Not a single `tax_total_cents` on the expense and nothing else, because an
 * input tax credit is claimed PER TAX and not per receipt. A Quebec receipt
 * carries GST and QST, which are claimed on two different returns at two
 * different times; an Ontario one carries HST, of which a portion may be
 * recoverable and the rest is not. Collapsed into one figure, none of that is
 * answerable, and the year-end question "how much GST did we pay" has no
 * source at all.
 *
 * `is_recoverable` is the column that turns tax paid into tax claimable. It is
 * per row and not per company: the same supplier's HST is recoverable on
 * materials and not on the portion of an expense that was never a business
 * input. Defaulted true, because a registrant's ordinary purchase is
 * recoverable and the exception is the thing worth ticking.
 *
 * `rate_ten_thou` is a snapshot taken from the `tax_rates` row that was in
 * force, for the reason `quote_taxes` snapshots one: a rate change must not
 * rewrite the tax on a receipt already filed. `tax_amount_cents` is not
 * derived from it -- it is what the paper says, and where the two disagree the
 * paper is the evidence.
 */
export const expenseTaxes = pgTable('expense_taxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  expenseId: uuid('expense_id').notNull().references(() => expenses.id),
  /** 'HST', 'GST', 'QST'. Snapshotted, so renaming a tax rate does not rewrite history. */
  label: text('label').notNull(),
  /** The registration the credit is evidenced against, when the tax rate carries one. */
  registrationNumber: text('registration_number'),
  rateTenThou: rate('rate_ten_thou').notNull(),
  /** Signed, so a credit note reverses its tax exactly as it reverses its subtotal. */
  taxAmountCents: cents('tax_amount_cents').notNull(),
  isRecoverable: boolean('is_recoverable').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
}, (t) => [index('expense_taxes_expense_idx').on(t.expenseId, t.sortOrder)]);
