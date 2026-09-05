import { z } from 'zod';
import type { FieldError } from '@/app/settings/result';
import { formatCents, formatQty, parseAmountToCents, parseQtyToMilli } from '@/lib/money/format';
import { lineTotalCents } from '@/lib/money/scale';

/**
 * How large a receipt may be.
 *
 * Ten megabytes is a generous phone photograph and a mean scanner output, and
 * the point of a ceiling at all is that the bytes are attacker-controlled: the
 * store reads at most this many plus one, which is the smallest amount of
 * evidence that a file is over the limit, so a refusal costs ten megabytes of
 * memory rather than however many somebody chose to send.
 *
 * Here rather than beside `LOGO_MAX_BYTES` in `lib/files/store.ts` because it
 * is this feature's policy, not the store's: a letterhead and a till receipt
 * are different kinds of file with different reasonable sizes, and the store
 * takes the cap as an argument precisely so neither has to be the other's.
 */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * What an expense looks like arriving from a form, and the three pure rules
 * worth writing down away from the action.
 *
 * Lives beside the actions rather than inside them because a `'use server'`
 * file may export nothing but async server actions, and because the
 * interesting parts here -- what `(45.00)` means, what a trip costs, whether
 * two figures may disagree in sign -- are the parts a test should be able to
 * reach without a database.
 */

/* -------------------------------------------------------------------------
   Money as a person types it
   ------------------------------------------------------------------------- */

/**
 * An amount off a receipt, in integer cents. SIGNED.
 *
 * Three ways the same figure arrives, and each one is decided rather than
 * guessed at:
 *
 * - `$1,234.50` -- a currency mark and a thousands separator, both dressing.
 *   123450 cents.
 * - `1234.5` -- one decimal place typed because the second was a zero.
 *   123450 cents. Padded, not multiplied: `parseFloat(x) * 100` is exact for
 *   this input and not for every input, and a parser that is only usually
 *   right is worse than one that is visibly strict.
 * - `(45.00)` -- accounting notation for a negative, which on an expense is a
 *   RETURN or a credit note. -4500 cents.
 *
 * The third is the one worth arguing about, and negative is allowed
 * deliberately: material goes back to the yard, a supplier issues a rebate,
 * and the job's cost genuinely falls. Refusing the sign would mean the only
 * way to record a return is not to record it, and the shoebox wins again.
 * `-45.00` and `−45.00` (the unicode minus a paste produces) read the same
 * way; `parseAmountToCents` normalises both.
 *
 * Three decimal places is refused rather than rounded. Nothing on a receipt
 * has three, so it is a typo or a quantity typed into a money box, and
 * silently turning 12.345 into 12.35 is how a total stops matching the paper.
 */
export const amountField = (options?: { allowBlank?: boolean; label?: string }) => {
  const { allowBlank = true } = options ?? {};
  const bad = 'must be an amount, with at most two decimal places';

  return z
    .string()
    .transform((value) => value.trim())
    .transform((raw) =>
      raw === ''
        ? { blank: true, value: null as number | null }
        : { blank: false, value: parseAmountToCents(raw) },
    )
    .refine((parsed) => allowBlank || !parsed.blank, 'is required')
    .refine((parsed) => parsed.blank || parsed.value !== null, bad)
    // A hundred million dollars on one receipt is a decimal point in the wrong
    // place, not a purchase. The ceiling is deliberately absurd rather than
    // tight: this is a typo catch, not a business rule about how much a
    // contractor may spend.
    .refine(
      (parsed) => parsed.value === null || Math.abs(parsed.value) <= 10_000_000_000,
      'is larger than any single receipt should be — check the decimal point',
    )
    // Blank reads as zero rather than null, because every money column on the
    // row is NOT NULL with a default of zero: a receipt with no tax on it had
    // no tax, which is a figure and not an absence.
    .transform((parsed) => parsed.value ?? 0);
};

/**
 * Kilometres, in integer thousandths.
 *
 * `parseQtyToMilli` lives in `format.ts` rather than `scale.ts`, and it
 * refuses any sign at all -- which is exactly right here. A negative distance
 * is not a credit the way a negative amount is; nobody un-drives a trip, and
 * a correction is a void plus a re-entry.
 */
export const distanceField = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value !== '', 'is required')
  .transform((raw) => parseQtyToMilli(raw))
  .refine((value) => value !== null, 'must be a distance, with at most three decimal places')
  .refine((value) => value === null || value > 0n, 'must be more than zero')
  // Two thousand kilometres is a drive across the country, not a site visit.
  // Again a typo catch: a decimal point missed on 150.5 gives 1505.
  .refine(
    (value) => value === null || value <= 2_000_000n,
    'is further than any single job trip — check the decimal point',
  )
  .transform((value) => value!);

/* -------------------------------------------------------------------------
   What a trip costs
   ------------------------------------------------------------------------- */

/**
 * The cost of a mileage entry, in integer cents.
 *
 * Distance is thousandths (10^3) and the rate is ten-thousandths of a currency
 * unit per kilometre (10^4), so their product carries 10^7; cents carry 10^2,
 * and the division lands on cents with half-away-from-zero rounding. That is
 * precisely `lineTotalCents`, which is the same arithmetic a quote line uses
 * -- reused rather than rewritten, because a second implementation of the
 * house rounding rule is a second answer waiting to disagree with the first.
 *
 * BigInt throughout. No JavaScript `number` touches this on the way.
 *
 * The rate is a PARAMETER and never read from settings inside this function.
 * Callers pass the rate that was snapshotted onto the row; passing the live
 * organization rate to re-cost an existing trip is the bug this whole feature
 * is arranged to prevent.
 */
export function mileageCostCents(distanceMilli: bigint, ratePerKmTenThou: bigint): number {
  return Number(lineTotalCents(distanceMilli, ratePerKmTenThou));
}

/**
 * A rate as a person reads it: `$0.7200/km` at four decimals, never trimmed.
 *
 * Four decimals because the difference between 0.72 and 0.7150 across ten
 * thousand kilometres is real money, and a display that dropped the last two
 * would make two different stored rates look identical on screen.
 */
export function formatRatePerKm(
  ratePerKmTenThou: bigint,
  opts?: { locale?: string; currencyCode?: string },
): string {
  const { locale = 'en-CA', currencyCode = 'CAD' } = opts ?? {};
  // Formatted through Intl against the tenant's currency rather than a `$`
  // literal: the product is white-label and a hardcoded symbol is wrong the
  // first time it is deployed anywhere else.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currencyCode,
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  }).format(Number(ratePerKmTenThou) / 10_000);
}

/** `42.5 km`, with the trailing zeroes a quantity does not need. */
export function formatDistance(distanceMilli: bigint, locale = 'en-CA'): string {
  return `${formatQty(distanceMilli, locale)} km`;
}

/**
 * The whole sentence a mileage row is entitled to: what was driven, at what
 * rate, for what. Written once because it is said on the list, in the
 * confirmation the action returns, and in the form's preview -- and because
 * every one of them must read the rate off the ROW.
 */
export function mileageSummary(
  row: { distanceMilli: bigint | null; ratePerKmTenThou: bigint | null; subtotalCents: number },
  opts?: { locale?: string; currencyCode?: string },
): string {
  if (row.distanceMilli === null || row.ratePerKmTenThou === null) return '—';
  const locale = opts?.locale ?? 'en-CA';
  return (
    `${formatDistance(row.distanceMilli, locale)} at ` +
    `${formatRatePerKm(row.ratePerKmTenThou, opts)}/km = ` +
    `${formatCents(row.subtotalCents, { locale, currencyCode: opts?.currencyCode })}`
  );
}

/* -------------------------------------------------------------------------
   The forms
   ------------------------------------------------------------------------- */

export const EXPENSE_LABELS: Record<string, string> = {
  projectId: 'Job',
  vendorId: 'Vendor',
  costCodeId: 'Cost code',
  expenseDate: 'Date',
  description: 'Description',
  reference: 'Receipt number',
  subtotal: 'Subtotal',
  paymentMethod: 'Paid by',
  vendorTaxNumberCaptured: 'Tax number on the receipt',
  isBillable: 'Billable to the customer',
  notes: 'Notes',
  receipt: 'Receipt',
  distance: 'Distance',
  reason: 'Reason',
  taxes: 'Tax',
};

export const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit card' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'etransfer', label: 'Transfer' },
  { value: 'account', label: 'On account — not paid yet' },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]['value'];

const paymentMethodValues = PAYMENT_METHODS.map((entry) => entry.value) as [
  PaymentMethod,
  ...PaymentMethod[],
];

/** An ISO date as `<input type="date">` submits it, refusing 2026-02-31. */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
  }, 'is not a real date');

/** A uuid, shaped rather than looked up: the action re-reads inside its transaction anyway. */
const requiredUuid = (message: string) => z.uuid(message);

const optionalUuid = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value === '' ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    'is not on the list',
  )
  .transform((value) => (value === '' ? null : value));

const optionalText = (max: number) =>
  z
    .string()
    .max(max, `must be ${max} characters or fewer`)
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? null : value));

const requiredDescription = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .refine((value) => value !== '', 'is required')
  .refine((value) => value.length <= 500, 'must be 500 characters or fewer');

/** What one receipt is, before its tax lines are read. */
export const purchaseFields = z.object({
  projectId: requiredUuid('is required — an expense with no job never reaches job costing'),
  vendorId: optionalUuid,
  costCodeId: optionalUuid,
  expenseDate: isoDate,
  description: requiredDescription,
  reference: optionalText(100),
  subtotal: amountField(),
  /**
   * Blank AND absent both mean "not said", and they have to, because they are
   * the same fact arriving two ways: a select left on its empty option posts
   * an empty string, and a form that has not grown the control yet posts
   * nothing at all. An enum that accepted only the first turns a missing
   * control into "Paid by: Invalid input", which is a sentence about a box
   * that is not on the screen.
   */
  paymentMethod: z
    .enum(paymentMethodValues)
    .or(z.literal(''))
    .optional()
    .transform((value) => (value === '' || value === undefined ? null : value)),
  /**
   * Copied off the paper, never looked up from the vendor. See the column's
   * note: the claim is evidenced by what the receipt said on the day.
   */
  vendorTaxNumberCaptured: optionalText(60),
  isBillable: z
    .stringbool()
    .optional()
    .transform((value) => value ?? false),
  notes: optionalText(2000),
});

export type PurchaseInput = z.output<typeof purchaseFields>;

/** A trip. No vendor, no receipt, no tax, no payment method — and no fields for them. */
export const mileageFields = z.object({
  projectId: requiredUuid('is required — a trip with no job is not a job cost'),
  costCodeId: optionalUuid,
  expenseDate: isoDate,
  description: requiredDescription,
  distance: distanceField,
  notes: optionalText(2000),
});

export type MileageInput = z.output<typeof mileageFields>;

/* -------------------------------------------------------------------------
   Tax lines
   ------------------------------------------------------------------------- */

export interface TaxLineInput {
  taxRateId: string;
  amountCents: number;
  isRecoverable: boolean;
}

/**
 * The tax boxes, read out of the form by name.
 *
 * One pair of controls per configured tax rate -- `tax_<id>` for the amount
 * and `recoverable_<id>` for the flag -- rather than a repeating row the
 * browser posts as an array. A form encoded by id is one whose fields cannot
 * get out of step with each other when a browser omits an unchecked box, which
 * is exactly what a parallel-arrays encoding does the first time somebody
 * unticks the middle one.
 *
 * A blank amount is not a tax line. That is the ordinary case -- one rate
 * configured, one box filled -- and writing a zero row for every rate the
 * company has ever had would put noise in front of whoever reconciles a
 * return.
 */
export function readTaxLines(
  values: Record<string, string>,
  rateIds: string[],
): { lines: TaxLineInput[]; malformed: string[] } {
  const lines: TaxLineInput[] = [];
  const malformed: string[] = [];

  for (const id of rateIds) {
    const raw = (values[`tax_${id}`] ?? '').trim();
    if (raw === '') continue;
    const amountCents = parseAmountToCents(raw);
    if (amountCents === null) {
      malformed.push(id);
      continue;
    }
    if (amountCents === 0) continue;
    lines.push({
      taxRateId: id,
      amountCents,
      // Absent means unticked, the way a browser posts a checkbox. The control
      // is rendered ticked, so absent here is a person who deliberately said
      // "this one is not claimable".
      isRecoverable: (values[`recoverable_${id}`] ?? '') !== '',
    });
  }

  return { lines, malformed };
}

/**
 * Whether the money on a row hangs together, in a sentence, or null.
 *
 * The one rule that is not a CHECK: tax and subtotal must not disagree in
 * sign. The database cannot usefully refuse it -- a rebate that carries tax
 * from a different receipt is conceivable -- but on a form it is always a
 * typed minus in the wrong box, and a credit note whose tax runs the other way
 * nets out to a figure nobody can trace back to a piece of paper.
 */
export function signMismatch(subtotalCents: number, taxTotalCents: number): string | null {
  if (subtotalCents === 0 || taxTotalCents === 0) return null;
  if (subtotalCents < 0 === taxTotalCents < 0) return null;
  return (
    'The subtotal and the tax point in opposite directions. A return is negative all the way' +
    ' through — subtotal and tax both — and a purchase is positive all the way through.'
  );
}

/* -------------------------------------------------------------------------
   The one database error the screen has a sentence for
   ------------------------------------------------------------------------- */

/**
 * A constraint the database refused, found wherever in the error it is.
 *
 * The chain walk is the corrected version, not the one in `rates/actions.ts`:
 * every write here runs inside a transaction -- a receipt and its tax lines
 * are one change -- and Drizzle wraps a transaction's failure in a
 * `DrizzleQueryError` that carries the driver's error on `cause`. Reading only
 * the top of that turns "the arithmetic on this row does not add up" into an
 * unexplained failure with the failed SQL and its bound parameters printed on
 * the screen.
 */
export function violatedConstraint(error: unknown): string | null {
  let current: unknown = error;
  // Bounded, because an error whose `cause` is itself would otherwise spin.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    const candidate = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
    if (candidate.code === '23514' || candidate.code === '23505' || candidate.code === '23503') {
      const name = candidate.constraint_name ?? candidate.constraint;
      return typeof name === 'string' ? name : 'unknown';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** What each CHECK means, said to the person who tripped it rather than to a log. */
export function constraintMessage(name: string): string | null {
  switch (name) {
    case 'expenses_total_identity':
      return 'The total did not come out as the subtotal plus the tax. Nothing was written.';
    case 'expenses_kind_shape':
      return 'A mileage entry carries no vendor, no receipt, no tax and no payment method, and a purchase carries no distance. Nothing was written.';
    case 'expenses_mileage_cost_identity':
      return 'The cost of that trip did not match the distance times the rate. Nothing was written.';
    case 'expenses_mileage_not_negative':
      return 'A distance and a rate are both positive. A correction is a void and a re-entry, not a negative trip.';
    case 'expenses_billed_only_when_billable':
      return 'That expense is already on a customer invoice, so it cannot stop being billable.';
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------
   What the screen says about a row
   ------------------------------------------------------------------------- */

/** The status word, so the list and the sheet cannot describe a row differently. */
export function expenseStatusLabel(status: string): string {
  switch (status) {
    case 'posted':
      return 'Posted';
    case 'review':
      return 'Needs review';
    default:
      return 'Captured';
  }
}

export function paymentMethodLabel(method: string | null): string {
  return PAYMENT_METHODS.find((entry) => entry.value === method)?.label ?? '—';
}

/* -------------------------------------------------------------------------
   Bulk entry
   ------------------------------------------------------------------------- */

/**
 * How many rows the grid offers at once.
 *
 * Eight, which is a run of receipts somebody can hold in one hand and not so
 * many that the form is a wall. The number is the only thing standing between
 * "type until you run out" and a page that renders eight vendor pickers, so it
 * is a real trade rather than a round number: raising it costs a longer page
 * on a phone, and lowering it costs a submit every few receipts.
 */
export const BATCH_ROWS = 8;

export interface BatchRow {
  /** Zero-based, so the message can say "Row 3" without arithmetic at the call site. */
  index: number;
  expenseDate: string;
  vendorId: string | null;
  costCodeId: string | null;
  description: string;
  reference: string | null;
  subtotalCents: number;
  taxCents: number;
  paymentMethod: PaymentMethod | null;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The filled rows of the grid, and a field error for each row that is half
 * filled in.
 *
 * A blank row is not an error: the grid always renders eight, and somebody
 * with three receipts leaves five alone. A row is "started" the moment it
 * carries a description, a subtotal, a tax figure or a reference -- and once
 * started it has to be complete, because a row with an amount and no words
 * beside it is a figure nobody can identify in a year, and a row with words
 * and no amount is a receipt somebody thinks they entered.
 *
 * Pure, and separate from the action, so the row rules can be tested without a
 * database or a request.
 */
export function readBatchRows(values: Record<string, string>): {
  rows: BatchRow[];
  errors: FieldError[];
} {
  const rows: BatchRow[] = [];
  const errors: FieldError[] = [];

  for (let index = 0; index < BATCH_ROWS; index += 1) {
    const at = (suffix: string) => (values[`r${index}_${suffix}`] ?? '').trim();
    const label = `Row ${index + 1}`;
    const description = at('desc').replace(/\s+/g, ' ');
    const subtotalRaw = at('sub');
    const taxRaw = at('tax');
    const reference = at('ref');

    if (description === '' && subtotalRaw === '' && taxRaw === '' && reference === '') continue;

    const push = (suffix: string, message: string) =>
      errors.push({ field: `r${index}_${suffix}`, label, message });

    if (description === '') push('desc', 'needs a description — a figure with no words beside it is unreadable a year later');
    if (description.length > 500) push('desc', 'must be 500 characters or fewer');

    const expenseDate = at('date');
    if (!datePattern.test(expenseDate)) {
      push('date', 'needs a date');
    } else {
      const [year, month, day] = expenseDate.split('-').map(Number);
      if (new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) !== expenseDate) {
        push('date', 'is not a real date');
      }
    }

    const subtotalCents = subtotalRaw === '' ? null : parseAmountToCents(subtotalRaw);
    if (subtotalRaw === '') {
      push('sub', 'needs an amount, or clear the rest of the row');
    } else if (subtotalCents === null) {
      push('sub', 'must be an amount, with at most two decimal places');
    }

    const taxCents = taxRaw === '' ? 0 : parseAmountToCents(taxRaw);
    if (taxCents === null) push('tax', 'must be an amount, with at most two decimal places');

    const vendorRaw = at('vendor');
    if (vendorRaw !== '' && !uuidPattern.test(vendorRaw)) push('vendor', 'is not on the list');

    const codeRaw = at('code');
    if (codeRaw !== '' && !uuidPattern.test(codeRaw)) push('code', 'is not on the list');

    const payRaw = at('pay');
    const paymentMethod = PAYMENT_METHODS.find((entry) => entry.value === payRaw)?.value ?? null;
    if (payRaw !== '' && paymentMethod === null) push('pay', 'is not a way money leaves');

    if (errors.some((error) => error.field.startsWith(`r${index}_`))) continue;

    rows.push({
      index,
      expenseDate,
      vendorId: vendorRaw === '' ? null : vendorRaw,
      costCodeId: codeRaw === '' ? null : codeRaw,
      description,
      reference: reference === '' ? null : reference,
      subtotalCents: subtotalCents!,
      taxCents: taxCents!,
      paymentMethod,
    });
  }

  return { rows, errors };
}
