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
  vendorTypeId: 'Vendor type',
  tradeId: 'Trade',
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A blankable id, refused unless it looks like one.
 *
 * Shaped rather than checked against the table, because the action re-reads
 * the row inside its own transaction anyway. What this stops is a hand-made
 * POST turning a foreign key column into a 23503 with the failed SQL on the
 * screen.
 */
const optionalUuid = (message: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value === '' || UUID.test(value), message)
    .transform((value) => (value === '' ? null : value));

/**
 * What the form submits. Note what is NOT here: `isSubcontractor`.
 *
 * It used to be a checkbox on this form, and it is now derived in the database
 * from the chosen type -- see `db/schema/vendor-lists.ts`. Three things and
 * nothing else turn on it (a T5018 slip, a WSIB clearance check, an assignment
 * picker), so leaving it submittable would leave the answer to a filing on a
 * field any browser can edit. The trigger reads `vendor_types`, this schema
 * cannot express the column, and `toColumns` below cannot write it.
 *
 * The trade is asked only of a vendor whose type performs work. The form hides
 * the field the rest of the time rather than removing it -- one DOM tree, so a
 * trade already picked survives a change of mind -- which means a value can
 * still arrive for a supplier. It is dropped in the action, from the type read
 * in the same transaction, rather than trusted here: this schema does not know
 * which types are subcontractor types and must not be given a way to guess.
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
  /**
   * Required, and required on an EDIT too. The vendors that predate the list
   * carry no type, and the way that data gets fixed is that the next person to
   * save one has to answer -- rather than the product answering for him, which
   * would be the product guessing at a tax filing.
   */
  vendorTypeId: z.string().trim().regex(UUID, 'is required'),
  tradeId: optionalUuid('is not a trade on the list'),
  // 3650 is ten years. Not a business rule -- there is no sane term above a
  // few months -- but the ceiling that stops a mistyped date landing in a
  // column measured in days.
  paymentTermsDays: optionalInt(0, 3650),
  defaultCostCodeId: optionalUuid('is not a cost code on the list'),
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
    vendorTypeId: input.vendorTypeId,
    tradeId: input.tradeId,
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
   The type, and the trade that follows from it
   ------------------------------------------------------------------------- */

/** The columns a chosen vendor type is judged on. Nothing else is read. */
export interface VendorTypeRef {
  id: string;
  name: string;
  isSubcontractor: boolean;
  isActive: boolean;
  recordStatus: string;
}

/** The columns a chosen trade is judged on. Nothing else is read. */
export interface TradeRef {
  id: string;
  name: string;
  isActive: boolean;
  recordStatus: string;
}

/**
 * Whether a vendor may be filed under the chosen type, and if not, why in a
 * sentence somebody can act on.
 *
 * Pure and separate from the action, because the rule is the interesting part
 * and the action is a transaction around it. The action supplies the row --
 * read inside the same transaction as the write, because a type that was on
 * the list when the form was rendered can be void by the time the button is
 * pressed, and because `is_subcontractor` is read off that same row.
 *
 * Void is refused and retired is allowed, and the asymmetry is the same one
 * `costCodeProblem` draws. Retired means "do not offer this on new vendors",
 * which is a statement about NEW vendors: somebody already on a winding-down
 * type must be able to have their phone number corrected without being moved,
 * and moving them is exactly what would restate whether they are owed a T5018.
 * Void means the row should never have existed, and a filing resting on a row
 * the screen calls a mistake is not a filing anybody can defend.
 */
export function vendorTypeProblem(type: VendorTypeRef | undefined): string | null {
  if (!type) return 'The vendor type you chose is not on the list.';
  if (type.recordStatus === 'void') {
    return `${type.name} is void, so nothing can be filed under it. Choose a type that still stands — whether a vendor counts as a subcontractor is read off this row, and a voided row is not an answer.`;
  }
  return null;
}

/**
 * Whether the trade answer fits the chosen type, and if not, why.
 *
 * The two halves of the owner's ask, written once: a supplier is not asked
 * which trade it is, and a subcontractor is not allowed to skip it. Called
 * with the trade the form sent -- which for a supplier may be a leftover,
 * because the field is hidden rather than removed so a value already picked
 * survives a change of mind. `null` is what the action should write in that
 * case; `problem` is what it should refuse with.
 *
 * The order matters: the type decides, and the trade obeys. Nothing here reads
 * a submitted flag.
 */
export function tradeProblem(input: {
  typeIsSubcontractor: boolean;
  /** Null when the field was left blank, or was never shown. */
  chosen: TradeRef | undefined | null;
  /** Whether an id was submitted at all, so a missing row can be told apart. */
  submitted: boolean;
}): string | null {
  const { typeIsSubcontractor, chosen, submitted } = input;

  // A supplier's trade is not refused, it is dropped. Refusing it would put a
  // message about a box that is not on the screen in front of somebody who was
  // correcting an address.
  if (!typeIsSubcontractor) return null;

  if (!submitted) {
    return 'Which trade is this? A subcontractor is somebody you hire to do a particular kind of work, and the trade is how the schedule and the vendor list say who to go looking for.';
  }
  if (!chosen) return 'The trade you chose is not on the list.';
  if (chosen.recordStatus === 'void') {
    return `${chosen.name} is void, so it should not be given to anybody new. Choose a trade that still stands, or add the right one under Settings, Trades.`;
  }
  return null;
}

/** What a supplier's trade becomes: nothing, whatever the form sent. */
export function tradeToWrite(typeIsSubcontractor: boolean, tradeId: string | null): string | null {
  return typeIsSubcontractor ? tradeId : null;
}

/* -------------------------------------------------------------------------
   What the screen says about a row
   ------------------------------------------------------------------------- */

/**
 * The one-line description of what a vendor is.
 *
 * Written once because it is said in three places -- the list, the sheet's
 * subtitle, and the confirmation an action returns -- and because the
 * distinction it draws is the one the whole table exists for. A reader who
 * cannot tell a subcontractor from a supplier at a glance cannot tell who is
 * owed a T5018.
 *
 * `typeName` is the tenant's own word for the kind of counterparty and is
 * preferred when there is one; it is optional because the vendors that predate
 * the type list have none, and because a caller who holds only the derived
 * flag -- the assignment picker, a confirmation message -- should not have to
 * join to say "Subcontractor". The flag, not the name, is what decides which
 * fallback is used: a type could be called anything.
 */
export function vendorKindLabel(row: {
  typeName?: string | null;
  isSubcontractor: boolean;
  trade: string | null;
}): string {
  const kind = row.typeName ?? (row.isSubcontractor ? 'Subcontractor' : 'Supplier');
  // A trade is only ever asked of a subcontractor, so printing one beside any
  // other kind would be printing a leftover as though it were a fact.
  return row.isSubcontractor && row.trade ? `${kind} · ${row.trade}` : kind;
}

/** Net days as a phrase, including the two cases a bare number gets wrong. */
export function paymentTermsLabel(days: number | null): string {
  if (days === null) return 'Not agreed';
  if (days === 0) return 'On delivery';
  return `Net ${days} days`;
}
