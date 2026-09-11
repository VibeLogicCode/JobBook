import { z } from 'zod';
import { type ActionResult, type FieldError, refused } from '@/app/settings/result';

/**
 * Zod builders shared by every settings and template action.
 *
 * They exist because an HTML form speaks only strings: an empty text input
 * arrives as `''`, an unchecked checkbox does not arrive at all, and a number
 * input arrives as text. Coercing that in each action by hand is where a blank
 * field silently becomes the number zero, or `''`, in a column that should
 * read NULL -- and a NULL postal code prints as nothing while an empty string
 * prints as nothing too, right up to the day something joins on it.
 */

/** A field the tenant may leave blank. Blank means NULL, never the empty string. */
export const optionalText = (max: number) =>
  z
    .string()
    .max(max, `must be ${max} characters or fewer`)
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? null : value));

/** A field the record cannot exist without. */
export const requiredText = (max: number) =>
  z.string().trim().min(1, 'is required').max(max, `must be ${max} characters or fewer`);

/**
 * A checkbox. Absent means unchecked -- a browser submits nothing at all for a
 * box that is not ticked, so `undefined` is the off state and not an error.
 */
export const checkbox = z
  .stringbool()
  .optional()
  .transform((value) => value ?? false);

/**
 * A field whose CONTROL may not be on the page.
 *
 * A browser sends no key for an input that was never rendered, and every
 * builder here starts at `z.string()` -- so absence arrives as "expected
 * string, received undefined" and the whole step refuses itself over a field
 * it deliberately did not show. That is how the setup wizard's financial step
 * first broke when it stopped asking a service-only company about holdback.
 *
 * Absent is folded into BLANK rather than made optional, so the builder's own
 * "blank means null" rule stays the single answer to "nothing was given" --
 * one rule, not two that disagree the day one of them changes.
 *
 * `checkbox` needs no wrapper: an unticked box is already this same absence,
 * which is why it is the one builder above that handles it itself.
 */
export const whenShown = <T extends z.ZodType>(field: T) =>
  z.preprocess((value) => (value === undefined ? '' : value), field);

/** A whole number, or NULL when the field is left blank. */
export const optionalInt = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value === '' || /^\d+$/.test(value), 'must be a whole number')
    .transform((value) => (value === '' ? null : Number(value)))
    .refine(
      (value) => value === null || (value >= min && value <= max),
      `must be between ${min} and ${max}`,
    );

/** A whole number the record cannot exist without. */
export const requiredInt = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => /^\d+$/.test(value), 'must be a whole number')
    .transform((value) => Number(value))
    .refine((value) => value >= min && value <= max, `must be between ${min} and ${max}`);

/** An ISO calendar date, as `<input type="date">` submits it. */
export const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date')
  .refine((value) => {
    // A regex accepts 2026-02-31. Round-tripping through UTC rejects it
    // without dragging the host timezone into a calendar question.
    const [year, month, day] = value.split('-').map(Number);
    const stamp = new Date(Date.UTC(year!, month! - 1, day!));
    return stamp.toISOString().slice(0, 10) === value;
  }, 'is not a real date');

/**
 * Turns zod issues into the field errors the form summary renders.
 *
 * `labels` maps a form control name to what the field is called on screen. The
 * map is written beside each schema rather than derived from the field name,
 * because "must be 200 characters or fewer" needs to say which field, and
 * "operatingName" is not what the label above the box says.
 */
export function invalid(
  error: z.ZodError,
  labels: Record<string, string>,
  summary = 'Some of these values need another look.',
): ActionResult {
  const fieldErrors: FieldError[] = error.issues.map((issue) => {
    const field = issue.path.map(String).join('.');
    return {
      field,
      label: labels[field] ?? field,
      message: issue.message,
    };
  });
  return refused(summary, fieldErrors);
}

/** Every entry of a submitted form, as the string the browser sent. */
export function formValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') values[key] = value;
  }
  return values;
}
