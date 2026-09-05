import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns } from '@/db/columns';
import { costCodes } from '@/db/schema/customers';

/**
 * Who gets paid: the lumber yard, the framer, the equipment hire, the
 * inspector (spec 3.2).
 *
 * The mirror of `customers`, and shaped like it on purpose. A customer is a
 * counterparty money arrives from; a vendor is a counterparty money leaves
 * for. Both are records somebody adds in the middle of a job rather than
 * settings somebody configures once, which is why the columns line up --
 * name, contact, one address, notes -- and why the screen sits at `/vendors`
 * beside `/customers` rather than inside settings the way `cost_codes` does.
 *
 * Everything after this table hangs off it. An expense is paid TO a vendor, a
 * schedule task is assigned TO a subcontractor, and the Phase 5 compliance
 * gate is a query against `is_subcontractor` and a WSIB expiry. The plan's
 * fourth decision is the reason it is a table at all: "Dave", "Dave M" and
 * "Dave Masonry" typed into three expense rows is a data problem no later
 * migration can unpick, because nothing in those three strings says they were
 * ever one person.
 */
export const vendors = pgTable('vendors', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** What he calls them. What appears on a picker, a receipt line, a schedule. */
  name: text('name').notNull(),
  /**
   * The name on the cheque, when it differs from the one on the truck.
   *
   * Separate from `name` rather than replacing it because a T5018 slip and a
   * subcontractor's invoice both carry the legal entity, while the person
   * coding a receipt at the end of the day is looking for the trading name.
   * One column would force one of those two to be wrong.
   */
  legalName: text('legal_name'),
  contactName: text('contact_name'),
  email: text('email'),
  phone: text('phone'),
  addressLine1: text('address_line1'),
  city: text('city'),
  /**
   * No default, for the reason `customers.province` has none: defaulting it
   * here would hardcode a tenant's region into the product. The form defaults
   * it from `organization.province` instead.
   */
  province: text('province'),
  postalCode: text('postal_code'),
  /**
   * The nine-digit CRA business number, and the T5018 requirement.
   *
   * A contractor who pays subcontractors files a T5018 statement of
   * contract payments, and the slip identifies the recipient by business
   * number. Collected on the day the sub is hired, because collecting it in
   * February from somebody who finished in August is how a filing gets late.
   */
  businessNumber: text('business_number'),
  /**
   * The GST/HST registration, which is a DIFFERENT number and must not be
   * merged into the one above.
   *
   * An input tax credit on a purchase over $30 has to be evidenced against
   * the supplier's registration number; the T5018 is evidenced against the
   * business number. A lumber yard has the second and is never on a T5018; a
   * small unregistered sub has the first and charges no tax. Collapsing the
   * two into one column loses the ability to say which claim a row supports.
   *
   * Note that `expenses.vendor_tax_number_captured` (spec 3.2) is still a
   * copy taken off the receipt rather than a join to this column: a
   * registration can change, and the claim is evidenced by what the paper
   * said on the day.
   */
  taxRegistrationNumber: text('tax_registration_number'),
  /**
   * NOT cosmetic, and not a category anyone should be able to guess at.
   *
   * True means this counterparty performs work rather than selling goods,
   * and three things follow from it that follow from nothing else: they
   * receive a T5018 slip, they need current WSIB clearance before they are
   * paid, and they appear in the schedule's assignment picker. A lumber yard
   * is none of those. False by default, because the safe error is leaving a
   * sub off the picker -- which somebody notices the same afternoon -- rather
   * than filing a T5018 for a building supply store.
   */
  isSubcontractor: boolean('is_subcontractor').notNull().default(false),
  /**
   * Free text rather than a foreign key to `cost_codes`.
   *
   * A trade is what you call somebody when you are looking for them --
   * "framer", "drywall" -- and a cost code is how their invoice is
   * categorised. They correlate and are not the same: one electrician's work
   * lands on rough-in and finish codes both. `default_cost_code_id` below is
   * the coding half, and this is the finding half.
   */
  trade: text('trade'),
  /**
   * Net days. Null means nothing was agreed, which is a different fact from
   * cash on delivery -- and zero is how cash on delivery is recorded.
   */
  paymentTermsDays: integer('payment_terms_days'),
  /**
   * Where this vendor's spend usually lands, so the expense form can propose
   * a code instead of asking for one on every receipt.
   *
   * A proposal, never a rule: the expense row will carry its own
   * `cost_code_id`, and changing this later must not recode a year of history.
   * A live foreign key rather than a snapshot for the same reason
   * `quote_lines.cost_code_id` is one -- a retired or voided code goes on
   * resolving here, and the picker says which it is.
   */
  defaultCostCodeId: uuid('default_cost_code_id').references(() => costCodes.id),
  notes: text('notes'),
  /**
   * "Do not offer this on new work." Retiring, and not deletion or voiding.
   *
   * A vendor you stopped using keeps every expense, assignment and T5018
   * total already recorded against them. `record_status = 'void'` is the
   * separate statement that the row should never have existed, and neither is
   * a delete: the application role holds no DELETE privilege at all.
   */
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns,
}, (t) => [
  /**
   * One vendor, one row, regardless of how it was capitalised.
   *
   * `lower(name)` rather than the column, because the whole point of the
   * table is that the same counterparty is not three rows -- and "Dave
   * Masonry" typed once in caps and once in title case is exactly that
   * failure wearing a disguise the eye skips over. The zod layer trims and
   * collapses internal whitespace before this ever sees the value, so the
   * remaining difference the index has to catch is case.
   *
   * On the column and not on the live rows, deliberately and for the reason
   * the cost code list gives: a partial index would free the name the moment
   * a row was retired, and the next person would create the duplicate this
   * table exists to prevent. The refusal message says which row holds it, and
   * whether that row is retired or void, so nobody is refused by something
   * they cannot see.
   */
  uniqueIndex('vendors_name_unique').on(sql`lower(${t.name})`),
  /**
   * The one query everything downstream makes: the active subcontractors.
   *
   * The schedule's assignment picker asks it, the compliance dashboard asks
   * it, and the T5018 run asks a version of it. Cheap now, and the index is
   * easier to add before the table has rows than after.
   */
  index('vendors_subcontractor_idx').on(t.isSubcontractor, t.isActive),
  // Net minus-thirty is not a term anybody agreed to. Null is "nothing agreed"
  // and zero is cash on delivery; below zero is a typo, and this is the last
  // place it can still be refused.
  check(
    'vendors_payment_terms_not_negative',
    sql`payment_terms_days is null or payment_terms_days >= 0`,
  ),
]);
