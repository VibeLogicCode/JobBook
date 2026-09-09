import { z } from 'zod';
import { checkbox } from '@/app/settings/validate';

/**
 * The shapes and the rules behind the two newest maintained lists --
 * `/settings/project-types` and `/settings/lead-sources`.
 *
 * One module for the pair, for the same reason `vendor-lists.ts` is one
 * module for its two: both screens want a name normalised the same way, an
 * order field, and the one database error each has a sentence for. Neither
 * list carries a rule the way `vendor_types.is_subcontractor` does -- there is
 * no asymmetry here, just two identical shapes with different words around
 * them.
 */

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  name: 'Name',
  sortOrder: 'Order',
  reason: 'Reason',
  posture: 'Offered for',
  holdback: 'Holdback applies',
  progressInvoicing: 'Billed in draws',
  scheduleTemplate: 'Has a schedule',
  constructionActDates: 'Construction Act dates',
  scopeInputs: 'Measurements',
};

export const LEAD_SOURCE_LABELS: Record<string, string> = {
  name: 'Name',
  sortOrder: 'Order',
  reason: 'Reason',
};

/**
 * Trimmed, and internal runs of whitespace collapsed to one space -- matching
 * `vendor-lists.ts`'s `listName`, for the reason stated there: the unique
 * index is on `lower(name)` and cannot by itself catch "Water leak" against
 * "Water  leak".
 */
const listName = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .refine((value) => value !== '', 'is required')
  .refine((value) => value.length <= 120, 'must be 120 characters or fewer');

/** Blank means nought, which sorts first and ties fall back to the name. */
const optionalOrder = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || /^\d{1,6}$/.test(value), 'must be a whole number')
  .transform((value) => (value === '' ? 0 : Number(value)));

/* -------------------------------------------------------------------------
   Project types
   ------------------------------------------------------------------------- */

export const projectTypeFields = z.object({
  name: listName,
  sortOrder: optionalOrder,
  /**
   * Which kind of work offers this type. `both` is the default and the value
   * that changes nothing about what any company sees.
   */
  posture: z.enum(['both', 'service', 'contract']).default('both'),
  /**
   * The five flags, as unchecked-means-false checkboxes.
   *
   * `checkbox` maps a missing key to false, which is exactly right on a full
   * submit -- an unchecked box sends nothing -- and exactly WRONG on a partial
   * one. Both project-type actions submit the whole record, the way every
   * settings form in this product does, so there is no partial case to guard.
   *
   * They default to TRUE rather than false, so a caller that somehow omitted
   * them writes today's behaviour. The off state is the one that would change
   * what a job does.
   */
  holdback: checkbox.default(true),
  progressInvoicing: checkbox.default(true),
  scheduleTemplate: checkbox.default(true),
  constructionActDates: checkbox.default(true),
  scopeInputs: checkbox.default(true),
});

export type ProjectTypeInput = z.output<typeof projectTypeFields>;

export function toProjectTypeColumns(input: ProjectTypeInput) {
  return {
    name: input.name,
    sortOrder: input.sortOrder,
    posture: input.posture,
    holdback: input.holdback,
    progressInvoicing: input.progressInvoicing,
    scheduleTemplate: input.scheduleTemplate,
    constructionActDates: input.constructionActDates,
    scopeInputs: input.scopeInputs,
  };
}

/* -------------------------------------------------------------------------
   Lead sources
   ------------------------------------------------------------------------- */

export const leadSourceFields = z.object({
  name: listName,
  sortOrder: optionalOrder,
});

export type LeadSourceInput = z.output<typeof leadSourceFields>;

export function toLeadSourceColumns(input: LeadSourceInput) {
  return { name: input.name, sortOrder: input.sortOrder };
}

/* -------------------------------------------------------------------------
   The one database error the screens have a sentence for
   ------------------------------------------------------------------------- */

/**
 * Postgres's unique-violation SQLSTATE, found wherever in the error it is.
 * Copied from `vendor-lists.ts` rather than imported -- see that file's own
 * note on why an untested error predicate is how this bug got in the first
 * time, and why it lives beside the schema rather than the actions.
 */
export function isDuplicateName(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* -------------------------------------------------------------------------
   What a picker calls a row
   ------------------------------------------------------------------------- */

/** The standing columns any list row is judged on. Nothing else is read. */
export interface ListRow {
  name: string;
  isActive: boolean;
  recordStatus: string;
}

/**
 * A row's name with its standing said out loud, for a select -- see
 * `vendor-lists.ts`'s `listOptionLabel` for why a retired or voided row still
 * has to appear in a picker that already points at it.
 */
export function listOptionLabel(row: ListRow): string {
  if (row.recordStatus === 'void') return `${row.name} (void)`;
  return row.isActive ? row.name : `${row.name} (retired)`;
}

/** A row as fetched for a picker: enough to build an option and a label. */
export interface ListRowRef extends ListRow {
  id: string;
}

/**
 * The options a picker offers: every row still on the list, plus -- appended,
 * marked -- whichever one a record already carries when that one is no
 * longer offered to new work.
 *
 * Shared by every screen that points at `project_types` or `lead_sources`
 * from outside Settings (the opportunity form, the quote starter, both
 * template editors, the customer form), so "retired means stop offering it on
 * new work, not blank the record that has it" is enforced in one place rather
 * than reimplemented per caller. Matches the vendor screen's own
 * `typeOptions`/`tradeOptions`, generalised: a `defaultValue` that matches no
 * `<option>` makes the browser silently show the FIRST one instead, which the
 * next save would then write for real.
 */
export function listOptions(
  rows: ListRowRef[],
  currentId?: string | null,
): { value: string; label: string }[] {
  const options = rows
    .filter((row) => row.isActive && row.recordStatus === 'active')
    .map((row) => ({ value: row.id, label: row.name }));

  if (currentId && !options.some((option) => option.value === currentId)) {
    const current = rows.find((row) => row.id === currentId);
    if (current) options.push({ value: current.id, label: listOptionLabel(current) });
  }
  return options;
}
