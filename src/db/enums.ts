import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every enum mirrors to SharePoint as **Text, not Choice**. A Choice column
 * validates against a fixed member list, so adding a value in a migration would
 * make every sync of that row fail with a 400 until somebody edited the list by
 * hand.
 */

/**
 * Deletion replacement. Nothing is ever deleted: a watermark sync cannot
 * observe a row that no longer exists, and these are tax records.
 */
export const recordStatusEnum = pgEnum('record_status', ['active', 'void']);

export const roleEnum = pgEnum('role', ['owner', 'admin', 'bookkeeper']);
export const customerTypeEnum = pgEnum('customer_type', ['residential', 'commercial']);
export const projectStageEnum = pgEnum('project_stage', [
  'lead', 'site_visit', 'quoting', 'quote_sent', 'won',
  'lost', 'in_progress', 'complete', 'on_hold',
]);
export const contractTypeEnum = pgEnum('contract_type', [
  'lump_sum', 'unit_price', 'cost_plus', 'time_and_material',
]);

/**
 * How a line calculates -- deliberately separate from what it is labelled.
 *
 * An earlier fused enum ('sqft'|'each'|'flat'|'percent'|'hour') conflated the
 * two: sqft, each and hour all compute identically, and only flat and percent
 * differ at all. Worse, it had no member for linear feet, so baseboard, trim,
 * countertop and fencing -- priced per linear foot by every contractor --
 * could not be entered, and a metric deployment could not say m2.
 */
export const calcModeEnum = pgEnum('calc_mode', ['qty', 'flat', 'percent']);

/** A change order IS a quote with a parent: same lines, engine, PDF, versioning. */
export const quoteKindEnum = pgEnum('quote_kind', ['estimate', 'change_order']);
export const changeReasonEnum = pgEnum('change_reason', [
  'customer_request', 'site_condition', 'design_change',
  'code_requirement', 'error_omission', 'allowance_reconciliation',
]);

/** How much pricing detail the customer document shows. */
export const pricingDisplayEnum = pgEnum('pricing_display', [
  'detailed', 'group_totals', 'lump_sum',
]);
export const clauseKindEnum = pgEnum('clause_kind', ['exclusion', 'assumption']);
export const areaUnitEnum = pgEnum('area_unit', ['sqft', 'sqm']);

/**
 * 'expired' is deliberately absent: expiry derives from valid_until, and a
 * stored value is wrong the moment the clock passes it.
 */
export const quoteStatusEnum = pgEnum('quote_status', [
  'draft', 'sent', 'accepted', 'declined', 'superseded',
]);

export const qtySourceEnum = pgEnum('qty_source', [
  'area', 'washrooms', 'kitchens', 'bedrooms', 'fixed', 'manual',
]);
export const entityTypeEnum = pgEnum('entity_type', [
  'organization', 'quote', 'project', 'customer', 'receipt',
  'vendor_invoice', 'purchase_order',
]);
export const filingFrequencyEnum = pgEnum('filing_frequency', ['annual', 'quarterly', 'monthly']);

/**
 * How a person signs in, chosen per user by an administrator.
 *
 * Only meaningful in `sso` mode. Under Cloudflare Access the Access policy
 * decides, and in local mode the environment does, so the column is ignored in
 * both -- which is why it is nullable rather than defaulted.
 */
export const loginMethodEnum = pgEnum('login_method', ['google', 'microsoft', 'apple']);

/**
 * Customer invoicing (spec 4.3 and 4.4).
 *
 * `invoice_kind` mirrors `InvoiceKind` in lib/invoice/types.ts member for
 * member. The engine declares its own union because it is pure and has to be
 * testable without a schema; this is the half the database enforces, and the
 * two lists drifting is the failure the mirroring comment there guards against.
 */
export const invoiceKindEnum = pgEnum('invoice_kind', [
  'deposit', 'progress', 'final', 'holdback_release', 'change_order',
]);

/**
 * Spec 4.3 lists 'overdue' and 'void' as members too. Both are dropped, for the
 * reasons this codebase has already settled elsewhere.
 *
 * 'overdue' derives from `due_date` against today, exactly as 'expired' derives
 * from `valid_until` on a quote -- and a stored value is wrong the moment the
 * clock passes it, with nobody to notice. 'void' is `record_status`; a second
 * place to say a record is void is a second place for the two to disagree.
 *
 * 'partial' and 'paid' stay, but nothing in this layer writes them: spec 4.5
 * derives an invoice's payment status from the sum of its payments, and the
 * payments table arrives in Phase 3. They are here so that layer has somewhere
 * to land rather than needing a migration to say what it already knows.
 */
export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft', 'sent', 'partial', 'paid',
]);

/** Receivable is withheld from us; payable is what we withhold from a sub. */
export const holdbackDirectionEnum = pgEnum('holdback_direction', ['receivable', 'payable']);
export const counterpartyTypeEnum = pgEnum('counterparty_type', ['customer', 'vendor']);

/**
 * What one holdback ledger row records.
 *
 * The ledger is a list of events, not a running balance -- see the note on
 * `holdbackLedger`. Without this column the event kind would have to be
 * inferred from which of the two amount columns is non-zero, and a corrective
 * accrual of zero cents would then be unreadable either way.
 */
export const holdbackEntryKindEnum = pgEnum('holdback_entry_kind', ['accrual', 'release']);

/**
 * Activity and reminders (spec 2, Phase 2 plan).
 *
 * These five mirror the unions in lib/reminders/types.ts member for member,
 * which the evaluator declares for itself because it is pure and has to be
 * testable without a database. `tests/unit/reminder-rules.test.ts` asserts the
 * pairing, so a member added on one side and forgotten on the other fails
 * there rather than at 3am in the scheduler.
 */

/**
 * What an activity or a reminder hangs off.
 *
 * Deliberately NOT the existing `entity_type`, which carries `organization`,
 * `receipt`, `vendor_invoice` and `purchase_order` as well. Nothing hangs a
 * timeline off a receipt, and reusing that enum would let the database hold a
 * reminder whose entity type the code has no branch for. Three members, and
 * the type union says the same three.
 *
 * The pair is a polymorphic reference and therefore not a foreign key -- see
 * the Phase 2 plan for why three nullable columns and a CHECK was the worse
 * trade.
 */
export const timelineEntityTypeEnum = pgEnum('timeline_entity_type', [
  'customer', 'project', 'quote',
]);

/**
 * What happened. Direction is part of the kind rather than a separate column
 * because "who called whom" is the whole content of a call record: a timeline
 * that says only `call` cannot tell the owner whether he chased the customer
 * or the customer chased him.
 */
export const activityKindEnum = pgEnum('activity_kind', [
  'call_in', 'call_out', 'email_in', 'email_out', 'sms',
  'site_visit', 'meeting', 'note',
]);

export const reminderKindEnum = pgEnum('reminder_kind', [
  'callback', 'follow_up', 'quote_expiring', 'site_visit', 'compliance', 'custom',
]);

/**
 * 'overdue' is deliberately absent, for the reason `quote_status` has no
 * 'expired' and `invoice_status` no 'overdue': it derives from the due date
 * against today, and a stored value is wrong the moment the clock passes it
 * with nobody there to notice.
 *
 * 'dismissed' is a decision about the reminder -- "I am not doing this" --
 * and is not `record_status = 'void'`, which says the row should never have
 * existed. Two different events, and they must not share a column.
 */
export const reminderStatusEnum = pgEnum('reminder_status', ['open', 'done', 'dismissed']);

export const reminderRecurrenceEnum = pgEnum('reminder_recurrence', [
  'none', 'daily', 'weekly', 'biweekly', 'monthly',
]);

export const reminderTriggerEnum = pgEnum('reminder_trigger', [
  'quote_sent', 'quote_expiring', 'stage_entered', 'no_activity',
  'site_visit_scheduled', 'project_won',
]);

/**
 * Job expenses, mileage and receipts (spec 3.2, and the mileage section of the
 * job-costs plan).
 */

/**
 * What kind of spend a row records, and the reason `expenses` is one table
 * rather than two.
 *
 * A mileage entry is not a purchase: nobody was paid, no receipt exists, and
 * there is no tax to claim. It is still a cost against the job, and job
 * costing is a single query per project only while every cost lives in one
 * table. The price of that is this discriminator and two columns that are
 * null on most rows; the price of two tables is every costing query becoming
 * a union, forever.
 */
export const expenseKindEnum = pgEnum('expense_kind', ['purchase', 'mileage']);

/**
 * Where the row came from. 'ocr' and 'import' are created here and left
 * unused, deliberately: the plan's third decision defers reading receipts, and
 * adding this column later would be a migration against a table that by then
 * holds a year of live spend.
 */
export const expenseSourceEnum = pgEnum('expense_source', ['manual', 'ocr', 'import']);

/**
 * How far along the capture workflow a row is (spec 3.3).
 *
 * 'review' is what an OCR-proposed row lands in and nothing writes yet.
 * 'posted' means a person confirmed it, and job costing counts posted rows
 * only -- which is why every row typed by hand is written 'posted' directly:
 * a person typing it IS the confirmation step, and a manual row parked at
 * 'captured' would be spend the owner entered and the costing view ignored.
 */
export const expenseStatusEnum = pgEnum('expense_status', ['captured', 'review', 'posted']);

/**
 * Schedule templates (spec 2026-09-05, section 5).
 */

/**
 * What a template task's DURATION scales with, or nothing.
 *
 * Mirrors `DurationSource` in `src/lib/schedule/template.ts` member for
 * member -- that file is pure and declares its own union so it stays testable
 * without a schema; this is the half the database enforces, and
 * `schedule_template_tasks_duration_source_columns` is what keeps the two from
 * drifting.
 */
export const durationSourceEnum = pgEnum('duration_source', [
  'none', 'area', 'washrooms', 'kitchens', 'bedrooms',
]);

/**
 * What a template task's PRESENCE conditions on, or nothing (a null pair of
 * condition columns, which section 6 states means unconditional rather than
 * "never applies").
 *
 * `area` is deliberately absent -- mirrors `ConditionMeasurement` in
 * `src/lib/schedule/template.ts`, and the reason is stated there: `area > 0` is
 * true of essentially every quote, so it would tick every task while looking
 * like a filter. Area stays a duration source only.
 */
export const conditionMeasurementEnum = pgEnum('condition_measurement', [
  'washrooms', 'kitchens', 'bedrooms',
]);
