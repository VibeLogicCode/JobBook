import { z } from 'zod';
import { optionalInt, optionalText, requiredText } from '@/app/settings/validate';

/**
 * The shape a vendor arrives in from a form, plus the one rule about the name
 * that is worth writing down.
 *
 * Nothing here parses a scaled integer the way `rates/schema.ts` does: a
 * vendor carries no money. What it carries instead is the name, and a
 * vendor's name matters more than most. The plan's fourth decision is that
 * subcontractors are real records rather than typed names, and the whole
 * value of that decision is one counterparty being one row. So the name is
 * normalised here rather than stored as typed -- leading and trailing space,
 * and a double space in the middle, are not three vendors.
 */

export const VENDOR_LABELS: Record<string, string> = {
  name: 'Name',
  legalName: 'Legal name',
  contactName: 'Contact',
  email: 'Email',
  phone: 'Phone',
  addressLine1: 'Address',
  city: 'City',
  province: 'Province',
  postalCode: 'Postal code',
  businessNumber: 'Business number',
  taxRegistrationNumber: 'Tax registration number',
  isSubcontractor: 'Subcontractor',
  trade: 'Trade',
  paymentTermsDays: 'Payment terms',
  defaultCostCodeId: 'Usual cost code',
  notes: 'Notes',
  reason: 'Reason',
};

/**
 * Trimmed, and internal runs of whitespace collapsed to one space.
 *
 * The unique index is on `lower(name)`, which catches case. It cannot catch
 * "Sample Supply" against "Sample  Supply" -- two rows, one counterparty,
 * and a difference nobody sees on a screen. Collapsing here is what makes the
 * index's promise the promise a reader would expect it to be.
 */
const nameField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .refine((value) => value !== '', 'is required')
  .refine((value) => value.length <= 200, 'must be 200 characters or fewer');

/**
 * A blankable id, refused unless it looks like one.
 *
 * Shaped rather than checked against the table, because the action re-reads
 * the row inside its own transaction anyway. What this stops is a hand-made
 * POST turning a foreign key column into a 23503 with the failed SQL on the
 * screen.
 */
const optionalUuid = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value === '' ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    'is not a cost code on the list',
  )
  .transform((value) => (value === '' ? null : value));

/**
 * The checkbox that decides who gets a T5018 slip and who appears in the
 * schedule's assignment picker.
 *
 * A browser sends nothing at all for a box that is not ticked, so absent is
 * the off state rather than an error -- which is also why this one cannot be
 * `required`: "not a subcontractor" is a real answer and has to be
 * submittable.
 */
export const vendorFields = z.object({
  name: nameField,
  legalName: optionalText(200),
  contactName: optionalText(200),
  email: optionalText(200),
  phone: optionalText(60),
  addressLine1: optionalText(200),
  city: optionalText(120),
  province: optionalText(60),
  postalCode: optionalText(20),
  businessNumber: optionalText(60),
  taxRegistrationNumber: optionalText(60),
  isSubcontractor: z
    .stringbool()
    .optional()
    .transform((value) => value ?? false),
  trade: optionalText(120),
  // 3650 is ten years. Not a business rule -- there is no sane term above a
  // few months -- but the ceiling that stops a mistyped date landing in a
  // column measured in days.
  paymentTermsDays: optionalInt(0, 3650),
  defaultCostCodeId: optionalUuid,
  notes: optionalText(2000),
});

export type VendorInput = z.output<typeof vendorFields>;

/**
 * Form names to column names, so no action writes the mapping by hand and
 * drifts from it. Same reason `settings/cost-codes/schema.ts` has one.
 */
export function toColumns(input: VendorInput) {
  return {
    name: input.name,
    legalName: input.legalName,
    contactName: input.contactName,
    email: input.email,
    phone: input.phone,
    addressLine1: input.addressLine1,
    city: input.city,
    province: input.province,
    postalCode: input.postalCode,
    businessNumber: input.businessNumber,
    taxRegistrationNumber: input.taxRegistrationNumber,
    isSubcontractor: input.isSubcontractor,
    trade: input.trade,
    paymentTermsDays: input.paymentTermsDays,
    defaultCostCodeId: input.defaultCostCodeId,
    notes: input.notes,
  };
}

/* -------------------------------------------------------------------------
   The one database error the screen has a sentence for
   ------------------------------------------------------------------------- */

/**
 * Postgres's unique-violation SQLSTATE, found wherever in the error it is.
 *
 * Caught rather than pre-checked because a check followed by an insert is two
 * statements with a gap between them, and the gap is where the second tab's
 * insert lands.
 *
 * The chain walk is the part worth keeping, and it is the corrected version
 * rather than the one in `rates/actions.ts`. That file reads `.code` off the
 * error directly and is right to, because its insert is a bare statement and
 * the driver's error arrives intact. Every write here runs inside a
 * transaction -- the default cost code has to still exist at the moment of the
 * write, not merely when the form was rendered -- and Drizzle wraps a
 * transaction's failure in a `DrizzleQueryError` that carries the original on
 * `cause`. Reading only the top of that turns "that name is already taken"
 * into an unexplained failure with the failed SQL and its bound parameters
 * printed on the screen.
 *
 * Lives here rather than beside the actions because a `'use server'` file may
 * export nothing but async server actions, and an untested error predicate is
 * how that bug got in the first time.
 */
export function isDuplicateName(error: unknown): boolean {
  let current: unknown = error;
  // Bounded, because an error whose `cause` is itself would otherwise spin.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* -------------------------------------------------------------------------
   The default cost code
   ------------------------------------------------------------------------- */

/** The columns a proposed cost code has to be judged on. Nothing else is read. */
export interface CostCodeRef {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  recordStatus: string;
}

/**
 * Whether a cost code may be a vendor's default, and if not, why in a
 * sentence somebody can act on.
 *
 * Pure and separate from the action, because the rule is the interesting part
 * and the action is a transaction around it. The action supplies the row --
 * read inside the same transaction as the write, because a code that was on
 * the list when the form was rendered can be void by the time the button is
 * pressed.
 *
 * Void is refused and retired is allowed, and the asymmetry is the point.
 * Retired means "do not offer this on new work", which is a statement about
 * NEW work -- a vendor who has always been coded to a winding-down division
 * should keep proposing it until somebody decides otherwise, and blanking it
 * would silently recode their next receipt. Void means the code should never
 * have existed, and proposing one of those on every future receipt would
 * spread a mistake rather than record it.
 */
export function costCodeProblem(code: CostCodeRef | undefined): string | null {
  if (!code) return 'The cost code you chose is not on the list.';
  if (code.recordStatus === 'void') {
    return `${code.code} is void, so it should not be proposed on new spend. Choose a code that still stands, or leave this blank and code each receipt as it arrives.`;
  }
  return null;
}

/* -------------------------------------------------------------------------
   What the screen says about a row
   ------------------------------------------------------------------------- */

/**
 * The one-line description of what a vendor is, from the two columns that
 * decide it.
 *
 * Written once because it is said in three places -- the list, the sheet's
 * subtitle, and the confirmation an action returns -- and because the
 * distinction it draws is the one the whole table exists for. A reader who
 * cannot tell a subcontractor from a supplier at a glance cannot tell who is
 * owed a T5018.
 */
export function vendorKindLabel(row: { isSubcontractor: boolean; trade: string | null }): string {
  if (!row.isSubcontractor) return 'Supplier';
  return row.trade ? `Subcontractor · ${row.trade}` : 'Subcontractor';
}

/** Net days as a phrase, including the two cases a bare number gets wrong. */
export function paymentTermsLabel(days: number | null): string {
  if (days === null) return 'Not agreed';
  if (days === 0) return 'On delivery';
  return `Net ${days} days`;
}
