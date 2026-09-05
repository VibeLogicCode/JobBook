import { z } from 'zod';
import { parseQtyToMilli, parseRateToTenThou } from '@/lib/money/format';

/**
 * The shape a rate item arrives in from a form.
 *
 * Every figure is turned into its stored scaled integer HERE, by the parsers
 * in `lib/money/format.ts`, and never by arithmetic on a JavaScript number.
 * That is not a style preference: `Number('4.05') * 10000` is 40499.999... on
 * a value an estimator typed by hand, and a rate item is multiplied by a
 * quantity on every quote that uses it.
 */

export const RATE_LABELS: Record<string, string> = {
  code: 'Code',
  description: 'Description',
  costCodeId: 'Cost code',
  calcMode: 'How it calculates',
  unitLabel: 'Unit',
  costRate: 'Cost',
  sellRate: 'Sell',
  isTaxable: 'Taxable',
  isAllowance: 'Allowance',
  defaultQty: 'Default quantity',
  sortOrder: 'Order',
  reason: 'Reason',
};

const RATE_SHAPE = 'must be a number with at most 4 decimal places';

/** A price the record cannot exist without. Negative is legal: a discount line. */
const requiredRate = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value !== '', 'is required')
  .refine((value) => parseRateToTenThou(value) !== null, RATE_SHAPE)
  .transform((value) => parseRateToTenThou(value)!);

/**
 * A price that may be left blank, which reads as zero.
 *
 * Zero rather than null because the column is NOT NULL and a cost of nothing
 * is a real answer -- a discount line costs nothing to deliver. What it is
 * not is a secret: the list shows a 100% margin against a zero cost, which is
 * conspicuous.
 */
const optionalRate = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || parseRateToTenThou(value) !== null, RATE_SHAPE)
  .transform((value) => (value === '' ? 0n : parseRateToTenThou(value)!));

/** A quantity is never negative, so `parseQtyToMilli` refusing a sign is the rule, not a bug. */
const optionalQty = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value === '' || parseQtyToMilli(value) !== null,
    'must be a positive number with at most 3 decimal places',
  )
  .transform((value) => (value === '' ? null : parseQtyToMilli(value)!));

const optionalOrder = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || /^\d{1,6}$/.test(value), 'must be a whole number')
  .transform((value) => (value === '' ? 0 : Number(value)));

const optionalUuid = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    'is not a cost code on the list',
  )
  .transform((value) => (value === '' ? null : value));

const checkbox = z
  .string()
  .optional()
  .transform((value) => value !== undefined && value !== '' && value !== 'false');

export const rateItemFields = z.object({
  code: z.string().trim().min(1, 'is required').max(60, 'must be 60 characters or fewer'),
  description: z.string().trim().min(1, 'is required').max(500, 'must be 500 characters or fewer'),
  costCodeId: optionalUuid,
  calcMode: z.enum(['qty', 'flat', 'percent'], 'must be quantity, flat or percent'),
  unitLabel: z.string().trim().max(20, 'must be 20 characters or fewer'),
  costRate: optionalRate,
  sellRate: requiredRate,
  isTaxable: checkbox,
  isAllowance: checkbox,
  defaultQty: optionalQty,
  sortOrder: optionalOrder,
});

export type RateItemInput = z.output<typeof rateItemFields>;

/**
 * Turns the form's names into the column names, so no action writes the
 * mapping by hand and drifts from it.
 */
export function toColumns(input: RateItemInput) {
  return {
    code: input.code,
    description: input.description,
    costCodeId: input.costCodeId,
    calcMode: input.calcMode,
    unitLabel: input.unitLabel,
    costRateTenThou: input.costRate,
    sellRateTenThou: input.sellRate,
    isTaxable: input.isTaxable,
    isAllowance: input.isAllowance,
    defaultQtyMilli: input.defaultQty,
    sortOrder: input.sortOrder,
  };
}

export const CALC_MODE_LABELS: Record<'qty' | 'flat' | 'percent', string> = {
  qty: 'By quantity',
  flat: 'A flat amount',
  percent: 'A percentage',
};

export const CALC_MODE_OPTIONS = (['qty', 'flat', 'percent'] as const).map((value) => ({
  value,
  label: CALC_MODE_LABELS[value],
}));
