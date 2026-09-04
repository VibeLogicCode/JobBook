import { z } from 'zod';
import { parseQtyToMilli, parseRateToTenThou } from '@/lib/money/format';

/**
 * Field builders for a scope template line.
 *
 * Both scaled values go through the money parsers rather than
 * `parseFloat(x) * 10000`. A float multiplication is exact for the values
 * anyone types by hand and inexact for enough of the rest that a multiplier
 * would occasionally land one ten-thousandth away from what was typed -- which
 * is invisible until it is a quantity on a priced line.
 */

/** Blank and malformed are told apart, because both would arrive as null. */
function parsed<T>(raw: string, parse: (value: string) => T | null) {
  const trimmed = raw.trim();
  return trimmed === ''
    ? { blank: true, value: null as T | null }
    : { blank: false, value: parse(trimmed) };
}

/**
 * The multiplier, in ten-thousandths: 1 is 10000, and one unit per fifty
 * square feet is 200.
 */
export const multiplierField = z
  .string()
  .transform((raw) => parsed(raw, parseRateToTenThou))
  .refine((result) => !result.blank, 'is required')
  .refine(
    (result) => result.blank || result.value !== null,
    'must be a number with at most four decimal places',
  )
  .refine(
    // Zero would derive every quantity as zero, and the expansion drops a
    // zero-quantity line -- so a template line with a zero multiplier is a
    // line that silently never appears.
    (result) => result.value === null || result.value > 0n,
    'must be greater than zero',
  )
  .transform((result) => result.value);

/** A fixed quantity, in thousandths. Blank is legitimate for every source but `fixed`. */
export const fixedQtyField = z
  .string()
  .transform((raw) => parsed(raw, parseQtyToMilli))
  .refine(
    (result) => result.blank || result.value !== null,
    'must be a quantity with at most three decimal places, and not negative',
  )
  .transform((result) => result.value);

export const qtySourceField = z.enum([
  'area',
  'washrooms',
  'kitchens',
  'bedrooms',
  'fixed',
  'manual',
]);

export const projectTypeField = z.enum([
  'custom_home',
  'basement',
  'renovation',
  'kitchen',
  'bathroom',
  'addition',
  'commercial_ti',
  'water_leak',
  'other',
]);

/**
 * Where a quantity comes from, in the words a person uses.
 *
 * The set is an enum rather than a formula language on purpose: a
 * user-editable expression stored in a database column is an injection surface
 * and an unbounded support burden, and these six cover every case the design
 * describes.
 */
export const QTY_SOURCE_OPTIONS = [
  { value: 'area', label: 'Area' },
  { value: 'washrooms', label: 'Washroom count' },
  { value: 'kitchens', label: 'Kitchen count' },
  { value: 'bedrooms', label: 'Bedroom count' },
  { value: 'fixed', label: 'A fixed quantity' },
  { value: 'manual', label: 'Typed on the quote' },
];

export const PROJECT_TYPE_OPTIONS = [
  { value: 'custom_home', label: 'Custom home' },
  { value: 'basement', label: 'Basement' },
  { value: 'renovation', label: 'Renovation' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'bathroom', label: 'Bathroom' },
  { value: 'addition', label: 'Addition' },
  { value: 'commercial_ti', label: 'Commercial tenant improvement' },
  { value: 'water_leak', label: 'Water leak' },
  { value: 'other', label: 'Other' },
];

export const PROJECT_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  PROJECT_TYPE_OPTIONS.map((option) => [option.value, option.label]),
);

export const QTY_SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  QTY_SOURCE_OPTIONS.map((option) => [option.value, option.label]),
);
