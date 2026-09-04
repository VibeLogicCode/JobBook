import { sql } from 'drizzle-orm';
import {
  boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { auditColumns, cents, qty, rate } from '@/db/columns';
import {
  calcModeEnum, counterpartyTypeEnum, holdbackDirectionEnum, holdbackEntryKindEnum,
  invoiceKindEnum, invoiceStatusEnum,
} from '@/db/enums';
import { costCodes, projects } from '@/db/schema/customers';
import { quoteLines } from '@/db/schema/quotes';

/**
 * A customer invoice: what was billed, when, and against what state of the job.
 *
 * These rows are the only record of what a job has billed. There is no
 * `projects.billed_to_date` and no stored holdback balance, for the reason
 * there is no `projects.contract_value` either (spec 4.1): the first time
 * anything is voided the stored figure and the sum of the rows disagree, and
 * the one the screen happens to read is the one the owner plans against.
 * `deriveBillingState` in lib/invoice/repository.ts sums these instead.
 *
 * Voiding therefore reverses an invoice's effect on the job by construction --
 * a void row leaves the sum -- which is what makes `record_status = 'void'` a
 * complete substitute for the DELETE the application role does not hold.
 */
export const customerInvoices = pgTable('customer_invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  invoiceNumber: text('invoice_number').notNull(),
  kind: invoiceKindEnum('kind').notNull(),
  status: invoiceStatusEnum('status').notNull().default('draft'),

  /** The date whose tax rates applied. Never today; see the snapshot note below. */
  issueDate: date('issue_date').notNull(),
  /**
   * Derived at issue from `organization.payment_terms_days` and then frozen.
   *
   * Nullable, and null when the tenant has not configured terms: Ontario's
   * Prompt Payment clock is 28 days and other jurisdictions differ, so an
   * invented default would be a jurisdiction assumption wearing a number.
   */
  dueDate: date('due_date'),
  /** The billing period this draw covers. Presentational; the arithmetic is percent-based. */
  periodFrom: date('period_from'),
  periodTo: date('period_to'),

  /**
   * Work billed by this invoice, gross of holdback and exclusive of tax.
   *
   * NOT the sum of `customer_invoice_lines`. A progress invoice bills
   * `contract x percent complete - previously billed`; its lines, when it has
   * any, are the description of what that money covers. A CHECK tying the two
   * together would make every progress invoice unissuable.
   */
  subtotalCents: cents('subtotal_cents').notNull().default(0),
  taxTotalCents: cents('tax_total_cents').notNull().default(0),
  /**
   * SIGNED, and that is load-bearing: positive withholds from this invoice,
   * negative gives back -- a release, or the reversal that follows a percent
   * complete going backwards.
   *
   * One signed column rather than a `withheld` and a `released` pair, because
   * it keeps `total = subtotal - holdback + tax` a single expression for all
   * five kinds (the CHECK below is that identity). A pair would need the total
   * to branch on kind, and the branch nobody tested is the one that ships.
   */
  holdbackCents: cents('holdback_cents').notNull().default(0),
  /**
   * How much of `holdback_cents` is a payout rather than a reversal of accrual.
   *
   * Both are negative holdback on the invoice and they are not the same event:
   * a reversal says work turned out not to have been done, a release says money
   * was handed over. Without this column the derived accrued and released
   * balances cannot be told apart, and the ledger cannot be written.
   */
  holdbackReleasedCents: cents('holdback_released_cents').notNull().default(0),
  /** Drawn down from customer advances. Reduces what is payable today, not the work billed. */
  depositAppliedCents: cents('deposit_applied_cents').notNull().default(0),
  /**
   * What the tax was actually charged on, invoice-wide.
   *
   * Redundant with the per-rate bases in `customer_invoice_taxes` while there
   * is at least one rate -- and the whole record of it when there is none, for
   * an exempt customer or a period with no rate in force. An invoice that
   * cannot say what it did not tax cannot be reconciled against a return.
   */
  taxableBaseCents: cents('taxable_base_cents').notNull().default(0),
  totalCents: cents('total_cents').notNull().default(0),
  amountDueCents: cents('amount_due_cents').notNull().default(0),

  /**
   * Snapshot fields (spec 4.5). Without them a progress invoice cannot be
   * reproduced once a later change order moves the contract value.
   *
   * `previously_billed_cents` is GROSS of holdback and EXCLUDES deposits, the
   * same definition `JobBillingState` carries and for the same two reasons: a
   * net figure would re-bill the previous draw's withholding on every draw, and
   * a deposit counted here as well as drawn down would credit the customer for
   * the same money twice.
   */
  contractValueAtInvoiceCents: cents('contract_value_at_invoice_cents').notNull().default(0),
  percentCompleteTenThou: rate('percent_complete_ten_thou'),
  previouslyBilledCents: cents('previously_billed_cents').notNull().default(0),
  /**
   * The withholding rate this invoice applied, read from the accepted quote
   * rather than from the organization default, which may have moved since the
   * contract was signed.
   */
  holdbackPctTenThou: rate('holdback_pct_ten_thou'),
  /**
   * `organization.tax_deferred_on_holdback` as it stood at issue.
   *
   * Snapshotted rather than read live because it decides whether the holdback
   * was taxed on this invoice or deferred to the release. Flipping the setting
   * mid-job would otherwise rewrite the tax treatment of invoices already sent,
   * and the release invoice would tax a holdback whose progress invoices had
   * already taxed it.
   */
  taxDeferredOnHoldback: boolean('tax_deferred_on_holdback').notNull(),

  sentAt: timestamp('sent_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  notes: text('notes'),
  ...auditColumns,
}, (t) => [
  // Numbers come from document_sequences, one series per year, so a collision
  // here means the allocator was bypassed. A voided invoice keeps its number
  // and nothing reissues it: a gap in the series is the record that a document
  // existed, which is exactly what an auditor asks about.
  uniqueIndex('customer_invoices_number_unique').on(t.invoiceNumber),
  index('customer_invoices_project_idx').on(t.projectId, t.issueDate),

  // The engine's own identity, enforced where a wrong sign cannot hide. Get the
  // holdback convention backwards and this refuses the insert instead of
  // shipping an invoice that is short by twice the withholding.
  check(
    'customer_invoices_total_identity',
    sql`total_cents = subtotal_cents - holdback_cents + tax_total_cents`,
  ),
  check(
    'customer_invoices_amount_due_identity',
    sql`amount_due_cents = total_cents - deposit_applied_cents`,
  ),
  // A holdback release bills no work. The money was already inside the
  // subtotals of the progress invoices that withheld it, so putting the payout
  // here would report 110% of the contract as revenue on the WIP schedule --
  // and the second 10% would look like a real draw.
  check(
    'customer_invoices_release_bills_no_work',
    sql`kind <> 'holdback_release' or subtotal_cents = 0`,
  ),
  // Only a release pays holdback out. A payout is never negative; a give-back
  // that is a reversal of accrual belongs in `holdback_cents` alone.
  check(
    'customer_invoices_release_only_on_release',
    sql`holdback_released_cents = 0 or (kind = 'holdback_release' and holdback_released_cents > 0)`,
  ),
  // The percent complete is the figure that was billed, so it is present on
  // exactly the kinds that bill by it. A deposit carrying one would mean the
  // owner's completion judgement was typed and then discarded.
  check(
    'customer_invoices_percent_on_progress_only',
    sql`(kind in ('progress', 'final')) = (percent_complete_ten_thou is not null)`,
  ),
  // 0%..100%. Above 100% is not a completion figure at all: billing past the
  // contract needs a change order that raises the contract, and this is the
  // last place that can still be refused.
  check(
    'customer_invoices_percent_in_range',
    sql`percent_complete_ten_thou is null
        or (percent_complete_ten_thou >= 0 and percent_complete_ten_thou <= 10000)`,
  ),
  // A 'final' that leaves the contract part-billed is a mislabelled progress
  // invoice, and the label is what the holdback release clock and the WIP
  // schedule read.
  check(
    'customer_invoices_final_bills_in_full',
    sql`kind <> 'final' or percent_complete_ten_thou = 10000`,
  ),
]);

/**
 * An invoice line is an immutable financial record, exactly like a quote line.
 *
 * Description, calc mode, unit label and the rate are copies taken at issue.
 * If a line resolved a live rate, raising that rate would silently rewrite what
 * an invoice already sent to a customer says it charged for.
 *
 * Lines are DESCRIPTION, not arithmetic: the invoice's own subtotal comes from
 * the contract and the percent complete, and these rows say what that covers.
 * That is why there is no percent calc mode here and no CHECK summing them to
 * the header -- a percent line needs a line base to take a share of, and an
 * invoice has none.
 *
 * Spec 4.3 gives this table both a `source_quote_line_id` and a
 * `source_change_order_line_id`. The second is dropped: spec 4.1 deleted
 * `change_order_lines` and made a change order a quote with a parent, so a
 * change-order line IS a `quote_lines` row and two foreign keys would point at
 * one table. Which of the two a writer filled in would then be a coin flip that
 * every reader had to allow for.
 */
export const customerInvoiceLines = pgTable('customer_invoice_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => customerInvoices.id),
  sortOrder: integer('sort_order').notNull(),
  lineGroup: text('line_group').notNull().default(''),
  code: text('code').notNull().default(''),
  description: text('description').notNull(),
  calcMode: calcModeEnum('calc_mode').notNull(),
  unitLabel: text('unit_label').notNull().default(''),
  /** Snapshotted; what Phase 3 groups actual cost against. */
  costCodeId: uuid('cost_code_id').references(() => costCodes.id),
  /** Provenance only, never read for pricing. Null for an ad-hoc line. */
  sourceQuoteLineId: uuid('source_quote_line_id').references(() => quoteLines.id),
  qtyMilli: qty('qty_milli').notNull(),
  unitPriceTenThou: rate('unit_price_ten_thou').notNull(),
  lineTotalCents: cents('line_total_cents').notNull(),
  isTaxable: boolean('is_taxable').notNull().default(true),
  notes: text('notes'),
  ...auditColumns,
}, (t) => [
  index('customer_invoice_lines_invoice_idx').on(t.invoiceId, t.sortOrder),
  check('customer_invoice_lines_no_percent_mode', sql`calc_mode <> 'percent'`),
]);

/**
 * Snapshotted tax breakdown, one row per rate -- the same rule as
 * `quote_taxes`, and for the same reason.
 *
 * The rates are read once, at issue, against the issue date, and never
 * re-resolved. Resolving them live would mean a rate change silently rewriting
 * the tax on every invoice already in a customer's hands, including the ones
 * whose period has already been filed.
 */
export const customerInvoiceTaxes = pgTable('customer_invoice_taxes', {
  id: uuid('id').primaryKey().defaultRandom(),
  invoiceId: uuid('invoice_id').notNull().references(() => customerInvoices.id),
  label: text('label').notNull(),
  registrationNumber: text('registration_number'),
  rateTenThou: rate('rate_ten_thou').notNull(),
  taxableBaseCents: cents('taxable_base_cents').notNull(),
  taxAmountCents: cents('tax_amount_cents').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  ...auditColumns,
}, (t) => [index('customer_invoice_taxes_invoice_idx').on(t.invoiceId, t.sortOrder)]);

/**
 * Holdback, as a list of events rather than a running balance.
 *
 * Spec 4.4 gives this table `accrued_cents`, `released_cents` and ONE
 * `invoice_id`, which cannot be right: a holdback accrues across every progress
 * invoice on the job and is released by a single release invoice, so one row
 * with one foreign key can name at most one of the two sides. Filling it with
 * the accruing invoice loses the release; filling it with the release loses the
 * dozen draws that built the balance, which are the rows a lien claim actually
 * has to evidence.
 *
 * Resolved by keeping the spec's column names and making each row ONE event:
 * `entry_kind` says which, `invoice_id` names the invoice that caused it, and
 * the balance is the sum. Both sides are then expressible, each against its own
 * invoice, and the accountant export still finds the fields it was promised.
 * A pair of nullable columns -- `accrued_by_invoice_id` and
 * `released_by_invoice_id` on one balance row -- was the alternative, and it is
 * this design with the event kind encoded in which column is null, plus a
 * running total that has to be updated in place on every draw.
 *
 * This is a PROJECTION of the invoices, not a second source of truth: the
 * billing state is derived from `customer_invoices` and these rows are written
 * from the same figures in the same transaction. Deriving the balance from here
 * instead would give holdback two authorities that disagree the first time one
 * of them is voided. What this table adds is the AR bucket and the release
 * clock -- and the payable side, which has no customer invoice behind it at all.
 */
export const holdbackLedger = pgTable('holdback_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull().references(() => projects.id),
  direction: holdbackDirectionEnum('direction').notNull(),
  counterpartyType: counterpartyTypeEnum('counterparty_type').notNull(),
  /**
   * Polymorphic across customers and vendors, so no foreign key -- the same
   * shape as `files.entity_id` and for the same reason. `vendors` arrives in
   * Phase 3; a constraint written now would have to name a table that does not
   * exist, or silently allow only customers.
   */
  counterpartyId: uuid('counterparty_id').notNull(),
  entryKind: holdbackEntryKindEnum('entry_kind').notNull(),
  /** The invoice that caused this event. Null on the payable side and on a manual adjustment. */
  invoiceId: uuid('invoice_id').references(() => customerInvoices.id),
  /**
   * Withheld by this event. SIGNED: a draw that reverses work reverses its
   * withholding, and that correction is an accrual of a negative amount rather
   * than a release, because no money moved.
   */
  accruedCents: cents('accrued_cents').notNull().default(0),
  /** Paid out by this event. Never negative; a give-back is a negative accrual. */
  releasedCents: cents('released_cents').notNull().default(0),
  /** Substantial performance plus `organization.holdback_release_days`. */
  releaseEligibleDate: date('release_eligible_date'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  notes: text('notes'),
  ...auditColumns,
}, (t) => [
  index('holdback_ledger_project_idx').on(t.projectId, t.direction),
  index('holdback_ledger_invoice_idx').on(t.invoiceId),
  // One event per row, so the two amounts are never both live. Deliberately NOT
  // a constraint that sum(accrued) >= sum(released): a correction after a
  // release can genuinely leave the outstanding balance negative, and that
  // money is owed back. Refusing the correction would only hide it.
  check(
    'holdback_ledger_one_event_per_row',
    sql`case entry_kind
          when 'accrual' then released_cents = 0
          when 'release' then accrued_cents = 0 and released_cents >= 0
        end`,
  ),
]);
