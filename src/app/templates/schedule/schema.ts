import { z } from 'zod';
import { parseQtyToMilli } from '@/lib/money/format';
import { optionalInt, optionalText, requiredInt, requiredText } from '@/app/settings/validate';
// Read-only reuse of the quote template's project-type validator. The two
// template kinds share nothing else (section 4 of the design doc is explicit
// that they are two tables, not one with a `kind`), but a project type is a
// project type regardless of which template names it, and a second copy here
// would drift from this one the first time its shape changed.
import { projectTypeIdField } from '@/app/templates/schema';

/**
 * Field builders for the schedule template screen -- the template's own
 * name/type/description, and the seven-shape task shape from section 5 of
 * `docs/superpowers/specs/2026-09-05-schedule-templates-design.md`.
 *
 * Mirrors `src/app/templates/schema.ts`'s shape on purpose (a blankable id,
 * money-scale parsers instead of `parseFloat`, one `optionalUuid` rather than
 * a lookup) without importing its private helpers -- those are not exported,
 * and this file must not edit that one to change that.
 */

export { projectTypeIdField };

export const TEMPLATE_LABELS: Record<string, string> = {
  name: 'Name',
  projectTypeId: 'Project type',
  description: 'Description',
};

export const updateScheduleTemplateSchema = z.object({
  id: z.string().uuid(),
  name: requiredText(200),
  projectTypeId: projectTypeIdField,
  description: optionalText(1000),
});

export const activeSchema = z.object({
  id: z.string().uuid(),
  isActive: z.stringbool(),
});

/**
 * A blankable id, shaped rather than looked up -- matching the reasoning
 * `src/app/projects/[id]/schedule/schema.ts` states for its own copy: the
 * action re-reads the row inside its own transaction regardless, because a
 * trade or a predecessor chosen when the form was rendered may be void by the
 * time it is submitted.
 */
const optionalUuid = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    'is not on the list',
  )
  .transform((value) => (value === '' ? null : value));

/**
 * A whole number that may be negative -- `requiredInt` in
 * `src/app/settings/validate.ts` refuses a leading `-` outright, which is
 * correct for every field it was written for and wrong for a lag: section 5.1
 * of the design doc and `lib/schedule/push.ts` both treat a negative lag as a
 * legitimate business figure (an overlap deliberately planned), not a typo.
 */
const requiredSignedInt = (min: number, max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .refine((value) => /^-?\d+$/.test(value), 'must be a whole number')
    .transform((value) => Number(value))
    .refine((value) => value >= min && value <= max, `must be between ${min} and ${max}`);

export const DURATION_SOURCE_OPTIONS = [
  { value: 'none', label: 'Nothing else — a fixed number of days' },
  { value: 'area', label: 'Area' },
  { value: 'washrooms', label: 'Washroom count' },
  { value: 'kitchens', label: 'Kitchen count' },
  { value: 'bedrooms', label: 'Bedroom count' },
];

export const CONDITION_KIND_OPTIONS = [
  { value: 'none', label: 'Every job' },
  { value: 'measurement', label: 'Only when a measurement is present' },
  { value: 'rateItem', label: 'Only when a rate item is quoted' },
];

export const CONDITION_MEASUREMENT_OPTIONS = [
  { value: 'washrooms', label: 'Washrooms' },
  { value: 'kitchens', label: 'Kitchens' },
  { value: 'bedrooms', label: 'Bedrooms' },
];

export const TASK_LABELS: Record<string, string> = {
  name: 'Task',
  tradeId: 'Trade',
  costCodeId: 'Cost code',
  sortOrder: 'Order',
  isMilestone: 'Kind of task',
  durationBaseDays: 'Base days',
  durationSource: 'Then scales with',
  durationAreaPerDay: 'Area per extra day',
  durationDaysPerUnit: 'Days per unit',
  predecessorTaskId: 'Waits on',
  lagDays: 'Lag',
  conditionKind: 'Applies',
  conditionMeasurement: 'Measurement',
  conditionRateItemId: 'Rate item',
  notes: 'Notes',
  reason: 'Reason',
};

/** Everything a template task form carries, before the cross-field rules below. */
const taskFieldShape = {
  name: requiredText(200),
  tradeId: optionalUuid,
  costCodeId: optionalUuid,
  notes: optionalText(2000),
  sortOrder: requiredInt(0, 9999),
  isMilestone: z.stringbool(),
  durationBaseDays: requiredInt(0, 3650),
  durationSource: z.enum(['none', 'area', 'washrooms', 'kitchens', 'bedrooms']),
  /** Sqft-per-day (or the tenant's own area unit), thousandths -- "a day per
   *  300 sqft" is 300000n. Blank and unparsable both collapse to null; the
   *  cross-field rule below is what turns a null into a refusal, only when
   *  the source actually needs it. */
  durationAreaPerDay: z.string().transform((raw) => {
    const trimmed = raw.trim();
    return trimmed === '' ? null : parseQtyToMilli(trimmed);
  }),
  durationDaysPerUnit: optionalInt(1, 3650),
  predecessorTaskId: optionalUuid,
  lagDays: requiredSignedInt(-365, 3650),
  conditionKind: z.enum(['none', 'measurement', 'rateItem']),
  conditionMeasurement: z
    .string()
    .transform((value) => value.trim())
    .transform((value) => (value === '' ? null : value))
    .refine(
      (value): value is 'washrooms' | 'kitchens' | 'bedrooms' | null =>
        value === null || value === 'washrooms' || value === 'kitchens' || value === 'bedrooms',
      'is not a real measurement',
    ),
  conditionRateItemId: optionalUuid,
};

/**
 * Section 5.3's CHECK constraints, transcribed into sentences a person reads
 * instead of a database error. Shared by add and edit so the two forms cannot
 * drift into refusing different things for the same input.
 *
 * What is deliberately NOT here: no-self-dependency and the cycle walk. Both
 * need `findPredecessorCycle` against the template's other rows, which needs a
 * database read -- so both live in the action, exactly where
 * `src/app/projects/[id]/schedule/actions.ts` puts the same check for the live
 * schedule.
 */
/** The fields every cross-field rule below actually reads -- a plain
 *  interface rather than a generic over the zod shape, because zod v4's
 *  inferred output for a spread shape is too complex a type for a generic
 *  helper to re-derive cleanly. Both `newTemplateTaskFields` and
 *  `editTemplateTaskFields` produce output structurally compatible with this. */
interface SharedTaskCheckInput {
  isMilestone: boolean;
  durationSource: 'none' | 'area' | 'washrooms' | 'kitchens' | 'bedrooms';
  durationAreaPerDay: bigint | null;
  durationDaysPerUnit: number | null;
  durationBaseDays: number;
  predecessorTaskId: string | null;
  lagDays: number;
  conditionKind: 'none' | 'measurement' | 'rateItem';
  conditionMeasurement: 'washrooms' | 'kitchens' | 'bedrooms' | null;
  conditionRateItemId: string | null;
}

function checkSharedTaskRules(input: SharedTaskCheckInput, ctx: z.RefinementCtx): void {
  if (!input.isMilestone) {
    if (input.durationSource === 'area') {
      if (input.durationAreaPerDay === null || input.durationAreaPerDay <= 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['durationAreaPerDay'],
          message: 'must be a number greater than zero when the duration scales with area',
        });
      }
    } else if (
      input.durationSource === 'washrooms' ||
      input.durationSource === 'kitchens' ||
      input.durationSource === 'bedrooms'
    ) {
      if (input.durationDaysPerUnit === null || input.durationDaysPerUnit <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['durationDaysPerUnit'],
          message: 'must be a whole number greater than zero for this duration source',
        });
      }
    } else if (input.durationBaseDays === 0) {
      // Section 5.1: "base 0 with source none is refused in the form. The
      // one-day floor exists for arithmetic, not to paper over a field
      // somebody forgot."
      ctx.addIssue({
        code: 'custom',
        path: ['durationBaseDays'],
        message: 'needs at least one day, or a source below that scales with something',
      });
    }
  }

  if (input.predecessorTaskId === null && input.lagDays !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['lagDays'],
      message: 'needs a task to lag behind — pick what this waits on, or set this back to zero',
    });
  }

  if (input.conditionKind === 'measurement' && input.conditionMeasurement === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['conditionMeasurement'],
      message: 'is required when the condition above is a measurement',
    });
  }
  if (input.conditionKind === 'rateItem' && input.conditionRateItemId === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['conditionRateItemId'],
      message: 'is required when the condition above is a rate item',
    });
  }
}

export const newTemplateTaskFields = z.object({ ...taskFieldShape }).superRefine(checkSharedTaskRules);
export type NewTemplateTaskInput = z.output<typeof newTemplateTaskFields>;

export const editTemplateTaskFields = z
  .object({ id: z.string().uuid(), ...taskFieldShape })
  .superRefine(checkSharedTaskRules);
export type EditTemplateTaskInput = z.output<typeof editTemplateTaskFields>;

export const voidTemplateTaskFields = z.object({
  id: z.string().uuid(),
  scheduleTemplateId: z.string().uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Whether a thrown error carries a given Postgres SQLSTATE, walking `cause`
 * chains -- copied from `src/app/projects/[id]/schedule/schema.ts` rather than
 * imported, because that file is owned by another agent's work on the live
 * schedule and this one must not reach into it.
 */
export function hasSqlState(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
