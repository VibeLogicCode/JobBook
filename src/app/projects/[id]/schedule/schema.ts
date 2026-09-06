import { z } from 'zod';
import type { FieldError } from '@/app/settings/result';
import { isoDate, optionalText, requiredText } from '@/app/settings/validate';
import { parseAmountToCents } from '@/lib/money/format';
import { daysBetween, durationDays } from '@/lib/schedule/calendar';
import type { HeldTask, TaskMove } from '@/lib/schedule/push';
import {
  conditionOutcome,
  isSuggested,
  type ConditionMeasurement,
  type ConditionOutcome,
  type DurationSource,
  type Scope,
  type ScopeEvidence,
  type TemplateTask,
} from '@/lib/schedule/template';
import type { Tone } from '@/components/ui/Pill';
import { isUuid } from '@/lib/ids';

/**
 * What a schedule task arrives as from a form, and what the screen says about
 * one.
 *
 * Nothing here parses money: a task carries no amount. What it carries is
 * dates, and the two rules about them are worth stating where the parsing
 * happens. Planned dates are edited only through `moveTaskDates`, because
 * changing one may move others and the owner has to see that first. Actual
 * dates are edited here, freely, and are never computed by anything.
 */

export const TASK_LABELS: Record<string, string> = {
  name: 'Task',
  tradeId: 'Trade',
  costCodeId: 'Cost code',
  plannedStart: 'Starts',
  plannedEnd: 'Finishes',
  actualStart: 'Actually started',
  actualEnd: 'Actually finished',
  isMilestone: 'Milestone',
  predecessorTaskId: 'Waits on',
  status: 'Status',
  notes: 'Notes',
  reason: 'Reason',
};

/**
 * A blankable id, shaped rather than looked up.
 *
 * The action re-reads the row inside its own transaction anyway -- it has to,
 * because a predecessor chosen when the form was rendered may have been voided
 * since. What this stops is a hand-made POST turning a foreign key into a
 * 23503 with the failed SQL on the screen.
 */
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

/** A date the record may not have yet. Blank is NULL, never today. */
const optionalIsoDate = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), 'must be a date')
  .transform((value) => (value === '' ? null : value))
  .refine(
    (value) => value === null || isoDate.safeParse(value).success,
    'is not a real date',
  );

export const TASK_STATUSES = ['not_started', 'in_progress', 'blocked', 'complete'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const statusField = z.enum(TASK_STATUSES);

/** Everything about a task except its planned dates. */
const taskDetailFields = {
  name: requiredText(200),
  tradeId: optionalUuid,
  costCodeId: optionalUuid,
  predecessorTaskId: optionalUuid,
  notes: optionalText(2000),
};

/**
 * Adding a task. Planned dates are typed here and only here without a preview,
 * because a task that does not exist yet has nothing waiting on it, so there is
 * nothing it could push.
 */
export const newTaskFields = z
  .object({
    ...taskDetailFields,
    plannedStart: isoDate,
    plannedEnd: isoDate,
    isMilestone: z
      .stringbool()
      .optional()
      .transform((value) => value ?? false),
  })
  // A milestone is a day. Collapsing it here rather than refusing the form is
  // deliberate: the checkbox already said what the person meant, and refusing
  // them for the end date they typed before ticking it would be pedantry.
  .transform((input) => (input.isMilestone ? { ...input, plannedEnd: input.plannedStart } : input))
  .refine((input) => input.plannedEnd >= input.plannedStart, {
    path: ['plannedEnd'],
    message: 'cannot be before the day it starts',
  });

export type NewTaskInput = z.output<typeof newTaskFields>;

/**
 * Editing a task. NO planned dates: those move through `moveTaskDates`, which
 * shows what else goes with them first.
 *
 * `isMilestone` is absent for the same reason. Turning a five-day task into a
 * milestone would collapse its finish date onto its start, which is a date
 * change that can push everything after it -- exactly the silent shift the
 * preview exists to prevent.
 */
export const editTaskFields = z
  .object({
    id: z.uuid('is not a task'),
    ...taskDetailFields,
    status: statusField,
    actualStart: optionalIsoDate,
    actualEnd: optionalIsoDate,
  })
  .refine((input) => input.actualEnd === null || input.actualStart !== null, {
    path: ['actualStart'],
    message: 'is needed before a finish date can be recorded',
  })
  .refine(
    (input) =>
      input.actualEnd === null || input.actualStart === null || input.actualEnd >= input.actualStart,
    { path: ['actualEnd'], message: 'cannot be before the day it started' },
  );

export type EditTaskInput = z.output<typeof editTaskFields>;

/** The move itself: one task, two dates, and the fingerprint of what was previewed. */
export const moveFields = z
  .object({
    id: z.uuid('is not a task'),
    plannedStart: isoDate,
    plannedEnd: isoDate,
    /** Empty on the first press, which is the request for a preview. */
    fingerprint: z.string().trim().max(128),
    /**
     * The dates the preview in front of the owner was computed for.
     *
     * Without these, editing a date after previewing and pressing the confirm
     * button would commit a move nobody had been shown: the fingerprint would
     * still match, because the SCHEDULE had not changed -- only the request
     * had. They are compared server-side rather than cleared by an onChange
     * handler, so the guarantee does not depend on the browser running any of
     * our JavaScript.
     */
    previewedStart: z.string().trim().max(10),
    previewedEnd: z.string().trim().max(10),
  })
  .refine((input) => input.plannedEnd >= input.plannedStart, {
    path: ['plannedEnd'],
    message: 'cannot be before the day it starts',
  });

export const voidTaskFields = z.object({
  id: z.uuid('is not a task'),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/* -------------------------------------------------------------------------
   What the move action hands back
   ------------------------------------------------------------------------- */

export interface PreviewRow {
  name: string;
  fromStart: string;
  fromEnd: string;
  toStart: string;
  toEnd: string;
  cause: TaskMove['cause'];
}

export interface HeldRow {
  name: string;
  downstreamNames: string[];
}

/**
 * The move action's result, which is NOT `ActionResult`.
 *
 * A settings action answers "saved" or "refused". This one has a third answer
 * -- "here is what would happen; do you want it" -- and that answer is the
 * point of the whole feature. Squeezing it into a success message would lose
 * the per-task detail, and squeezing it into an error would tell the owner
 * something went wrong when nothing has.
 */
export type MoveState =
  | {
      status: 'preview';
      sentence: string;
      rows: PreviewRow[];
      held: HeldRow[];
      fingerprint: string;
      /** The dates this preview describes, sent back so the confirm cannot drift off them. */
      plannedStart: string;
      plannedEnd: string;
      /** True when the schedule changed under the last preview and this one replaces it. */
      stale: boolean;
    }
  | { status: 'saved'; message: string; movedIds: string[] }
  | { status: 'refused'; error: string; fieldErrors?: FieldError[] };

export function previewRows(moves: readonly TaskMove[]): PreviewRow[] {
  return moves.map((move) => ({
    name: move.name,
    fromStart: move.fromStart,
    fromEnd: move.fromEnd,
    toStart: move.toStart,
    toEnd: move.toEnd,
    cause: move.cause,
  }));
}

export function heldRows(held: readonly HeldTask[]): HeldRow[] {
  return held.map((task) => ({ name: task.name, downstreamNames: task.downstreamNames }));
}

/* -------------------------------------------------------------------------
   What the screen says
   ------------------------------------------------------------------------- */

export const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: 'Not started',
  in_progress: 'On site',
  blocked: 'Blocked',
  complete: 'Complete',
};

/** Every state carries its word as well as its colour. */
export function statusTone(status: TaskStatus): Tone {
  switch (status) {
    case 'complete':
      return 'positive';
    case 'blocked':
      return 'negative';
    case 'in_progress':
      return 'info';
    default:
      return 'neutral';
  }
}

/** "5 days", and "1 day" rather than the bare number a milestone would show. */
export function durationLabel(plannedStart: string, plannedEnd: string): string {
  const days = durationDays(plannedStart, plannedEnd);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * What a task waits on, in words, including the two cases a bare number reads
 * wrong.
 *
 * Lag zero is "the day after", not "0 days after". A negative lag is an
 * overlap and has to say so, because "starts -2 days after framing" is a
 * sentence nobody parses on a phone in a driveway.
 */
export function waitsOnLabel(predecessorName: string, lagDays: number): string {
  if (lagDays === 0) return `The day after ${predecessorName}`;
  if (lagDays < 0) {
    const days = Math.abs(lagDays) - 1;
    if (days === 0) return `Starts the day ${predecessorName} ends`;
    return `Overlaps ${predecessorName} by ${days} ${days === 1 ? 'day' : 'days'}`;
  }
  return `${lagDays} ${lagDays === 1 ? 'day' : 'days'} after ${predecessorName}`;
}

/**
 * A calendar date for a person to read.
 *
 * `timeZone: 'UTC'` is load-bearing rather than lazy. These are date-only
 * values with no time in them; rendering one in a zone west of UTC prints the
 * day before, which on a schedule is the difference between Friday and the
 * weekend somebody was told they had.
 */
export function dayFormatter(locale: string): (iso: string) => string {
  const format = new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (iso: string) => format.format(new Date(`${iso}T00:00:00Z`));
}

/* -------------------------------------------------------------------------
   The database errors the screen has a sentence for
   ------------------------------------------------------------------------- */

/**
 * A SQLSTATE, found wherever in the error's cause chain it is.
 *
 * The chain walk rather than reading `.code` off the top, for the reason
 * `app/settings/cost-codes/actions.ts` gives: every write here runs inside a
 * transaction, and Drizzle wraps a transaction's failure in a
 * `DrizzleQueryError` that carries the driver's error on `cause`. Reading only
 * the top turns "these tasks wait on each other" into an unexplained failure
 * with the failed SQL and its bound parameters printed on the screen.
 */
export function hasSqlState(error: unknown, code: string): boolean {
  let current: unknown = error;
  // Bounded, because an error whose `cause` is itself would otherwise spin.
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/* -------------------------------------------------------------------------
   Assignments: who is doing the task
   ------------------------------------------------------------------------- */

export const ASSIGNMENT_LABELS: Record<string, string> = {
  scheduleTaskId: 'Task',
  assignee: 'Who',
  response: 'Have they said yes',
  agreedAmount: 'Agreed amount',
  notes: 'Notes',
  reason: 'Reason',
};

export type AssigneeKind = 'vendor' | 'user';
export interface Assignee {
  kind: AssigneeKind;
  id: string;
}

/** The value an option carries. Written once, so the form and the parse cannot drift. */
export function assigneeValue(kind: AssigneeKind, id: string): string {
  return `${kind}:${id}`;
}

export function parseAssignee(raw: string): Assignee | null {
  const separator = raw.indexOf(':');
  if (separator === -1) return null;
  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (kind !== 'vendor' && kind !== 'user') return null;
  if (!isUuid(id)) return null;
  return { kind, id };
}

const assigneeField = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => parseAssignee(value) !== null, 'is not somebody on the list')
  .transform((value) => parseAssignee(value)!);

/**
 * What was agreed for this task, in integer cents, or nothing at all.
 *
 * Blank is NULL and NOT zero, which is the opposite of the choice
 * `expenses.amountField` makes -- and the difference is the column, not the
 * taste. Every money column on an expense is NOT NULL, because a receipt with
 * no tax on it had no tax: that is a figure. An assignment with no agreed price
 * has no price YET, and writing zero would report a sub lined up for nothing.
 * Zero is still typeable and means agreed at zero -- an own-crew day, or work
 * folded into another line.
 *
 * Parsed by `lib/money/format`, which builds cents by concatenating digit
 * strings rather than multiplying a float by a hundred, and stored as those
 * cents. Nothing downstream computes against it, so no intermediate ever
 * becomes a JavaScript number carrying a fraction.
 */
const agreedAmountField = z
  .string()
  .transform((value) => value.trim())
  .transform((raw) =>
    raw === ''
      ? { blank: true, value: null as number | null }
      : { blank: false, value: parseAmountToCents(raw) },
  )
  .refine(
    (parsed) => parsed.blank || parsed.value !== null,
    'must be an amount, with at most two decimal places',
  )
  .refine(
    (parsed) => parsed.value === null || parsed.value >= 0,
    'cannot be negative — a credit from a sub is an expense with a sign on it, not a price',
  )
  // Ten million dollars for one task on one job is a decimal point in the
  // wrong place. A typo catch, not a rule about what work is worth.
  .refine(
    (parsed) => parsed.value === null || parsed.value <= 1_000_000_000,
    'is larger than one task should be — check the decimal point',
  )
  .transform((parsed) => parsed.value);

/**
 * Yes, no, or nothing heard back -- the three states the pair of dates can
 * hold, asked as the one question a person can actually answer.
 *
 * Named `response` rather than `status` because the row stores no status: it
 * stores `confirmed_at` and `declined_at`, and this is only how the screen asks
 * about them. The action maps this back to the dates and DOES NOT RESTAMP one
 * that is already set, so saving a note against a confirmed assignment cannot
 * silently move the day he said yes.
 */
export const ASSIGNMENT_RESPONSES = ['waiting', 'confirmed', 'declined'] as const;
export type AssignmentResponse = (typeof ASSIGNMENT_RESPONSES)[number];

export const RESPONSE_LABELS: Record<AssignmentResponse, string> = {
  waiting: 'Asked, nothing heard back',
  confirmed: 'Confirmed',
  declined: 'Said no',
};

export function responseTone(response: AssignmentResponse): Tone {
  switch (response) {
    case 'confirmed':
      return 'positive';
    case 'declined':
      return 'negative';
    default:
      // Not a warning. Nobody has done anything wrong by not having rung back
      // yet, and painting every fresh assignment amber makes the colour mean
      // nothing by the third task.
      return 'neutral';
  }
}

/** Which of the three a row is in, read off the dates rather than stored. */
export function responseOf(row: {
  confirmedAt: Date | null;
  declinedAt: Date | null;
}): AssignmentResponse {
  if (row.confirmedAt !== null) return 'confirmed';
  if (row.declinedAt !== null) return 'declined';
  return 'waiting';
}

export const newAssignmentFields = z.object({
  scheduleTaskId: z.uuid('is not a task'),
  assignee: assigneeField,
  agreedAmount: agreedAmountField,
  notes: optionalText(2000),
});

export const editAssignmentFields = z.object({
  id: z.uuid('is not an assignment'),
  response: z.enum(ASSIGNMENT_RESPONSES),
  agreedAmount: agreedAmountField,
  notes: optionalText(2000),
});

/**
 * Taking somebody off a task, which is neither a delete nor a void.
 *
 * The reason is required for the reason a void reason is: "Dave is not on
 * framing any more" with nothing beside it teaches nobody anything in
 * February, and this row is the only record that he ever was.
 */
export const removeAssignmentFields = z.object({
  id: z.uuid('is not an assignment'),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/* -------------------------------------------------------------------------
   Double-booking
   ------------------------------------------------------------------------- */

/** A stretch of calendar days a task occupies. Both ends inclusive. */
export interface Span {
  start: string;
  end: string;
}

/**
 * Whether two tasks share a day.
 *
 * Both ends inclusive, because `planned_start` and `planned_end` are: a
 * one-day task is the same date twice, and a half-open comparison would report
 * every milestone as clashing with nothing at all.
 *
 * ISO dates compare correctly as strings, which is why the columns are `date`
 * and the wire format is ISO rather than anything friendlier.
 */
export function spansOverlap(a: Span, b: Span): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** How many days two tasks share. Zero when they do not touch. */
export function overlapDays(a: Span, b: Span): number {
  if (!spansOverlap(a, b)) return 0;
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return daysBetween(start, end) + 1;
}

/** One other task the same person is already on, over days these two share. */
export interface Clash {
  taskName: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  span: Span;
  days: number;
}

/**
 * A double-booking, in a sentence.
 *
 * **This is a WARNING and never a refusal, and that is the decision this
 * helper exists to carry.**
 *
 * Refusing would be wrong, and not marginally. A schedule task stores calendar
 * days with no hours in them, so the data physically cannot tell "both of them
 * on Thursday morning" from "one Thursday morning and one Thursday afternoon"
 * -- and a sub really does split a day, and a ten-day framing task really does
 * overlap a one-day inspection he is also down for. Refusing on evidence that
 * cannot distinguish those would refuse correct schedules, and the owner would
 * learn inside a week to work around the picker rather than through it.
 *
 * Saying nothing would be worse, and this is the mistake the feature exists to
 * catch. The two tasks are on TWO DIFFERENT JOBS, therefore on two different
 * screens, so the one place a clash is naturally invisible is exactly where it
 * costs money: a framer promised to two sites on the same Tuesday, discovered
 * on the Tuesday.
 *
 * So it is written, and it is said -- once in the confirmation when the
 * assignment is made, and then permanently on the row, because a warning that
 * appears once and scrolls away is a warning nobody acted on.
 */
export function clashSentence(
  who: string,
  clashes: readonly Clash[],
  currentProjectId: string,
): string {
  if (clashes.length === 0) return '';
  const first = clashes[0]!;
  const elsewhere = clashes.some((clash) => clash.projectId !== currentProjectId);
  // The last clause is the reason this is said at all, so it has to be true.
  // A clash on ANOTHER job is invisible here; one on this job is two rows the
  // reader can already see, and claiming otherwise would teach them to
  // distrust the warning that matters.
  const why = elsewhere
    ? "but nothing else was going to tell you, because that work is on another job's screen."
    : 'so check the two are not the same hours before you promise them.';
  const where = elsewhere ? ` for ${first.projectNumber}` : ' on this job';
  if (clashes.length === 1) {
    return `${who} is also on ${first.taskName}${where}, and the two overlap by ${first.days} ${first.days === 1 ? 'day' : 'days'}. That is allowed — these dates carry no hours, and a sub can split a day — ${why}`;
  }
  return `${who} is also on ${clashes.length} other tasks that overlap these dates, starting with ${first.taskName}${where}. That is allowed — a sub can split a day — ${why}`;
}

/** The short form, for the pill that stays on the row. */
export function clashPillLabel(clashes: readonly Clash[], currentProjectId: string): string {
  if (clashes.length === 1) {
    const only = clashes[0]!;
    // Naming this job back at somebody looking at it says nothing. The task is
    // what they need, and it is on screen a few rows away.
    return only.projectId === currentProjectId
      ? `Also on ${only.taskName}`
      : `Also on ${only.projectNumber}`;
  }
  return `Also on ${clashes.length} other tasks`;
}

/* -------------------------------------------------------------------------
   Rendering a moment
   ------------------------------------------------------------------------- */

/**
 * A timestamp as the day it happened IN THE TENANT'S ZONE.
 *
 * `dayFormatter` above renders date-only values and pins UTC, because those
 * carry no time to convert. These do: `confirmed_at` is an instant, and a
 * confirmation taken at seven on a Toronto evening is stored as the next day in
 * UTC. Rendered in the server's zone it would read as tomorrow, which on a
 * screen about who turns up when is the difference between Friday and the
 * weekend somebody thought they had.
 */
export function momentFormatter(locale: string, timeZone: string): (at: Date) => string {
  const build = (zone: string) =>
    new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: zone,
    });
  let format: Intl.DateTimeFormat;
  try {
    format = build(timeZone);
  } catch {
    // An unrecognised zone on the organization row must not take the whole
    // schedule down. UTC is the same fallback `tenantToday` coalesces to.
    format = build('UTC');
  }
  return (at: Date) => format.format(at);
}

/**
 * A duplicate assignment, said in full.
 *
 * The unique index is partial -- live rows only -- so the row already holding
 * this person may have been added in another tab since this screen was drawn,
 * and a bare "already assigned" sends somebody hunting a row they cannot see.
 */
export function duplicateAssignmentText(who: string): string {
  return `${who} is already on this task. Somebody may have added them while this screen was open — reload the schedule to see it. Nothing was written.`;
}

/**
 * Integer cents back into the box somebody types an amount into.
 *
 * String surgery on the digits rather than `cents / 100`, so the round trip
 * from the column to the input and back is integer arithmetic the whole way:
 * `formatCents` divides because it is producing a string for a person to read
 * and never goes back, and this one is the value the next save re-parses.
 *
 * Unlocalised on purpose. `formatCents` groups thousands according to the
 * tenant's locale, and a grouping mark that `parseAmountToCents` does not
 * recognise -- a narrow no-break space in fr-CA, for one -- would turn opening
 * the sheet and pressing Save into a refusal on a figure nobody touched.
 */
export function centsToInput(cents: number): string {
  const digits = String(Math.abs(cents)).padStart(3, '0');
  return `${cents < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/* -------------------------------------------------------------------------
   Importing a schedule template -- spec
   docs/superpowers/specs/2026-09-05-schedule-templates-design.md, section 7.
   ------------------------------------------------------------------------- */

/**
 * A schedule template offered in the picker (section 7.1).
 *
 * Active templates only, matching the job's own project type sorted first --
 * "not filtered to them: a basement template is a reasonable start for a rec
 * room." The sort happens in the page, which is the one place that already
 * knows the job's `projectTypeId`; this is just what survives onto the wire.
 */
export interface ImportTemplateOption {
  id: string;
  name: string;
  projectTypeName: string;
  taskCount: number;
}

/**
 * One template task, wire-shaped for the client sheet.
 *
 * `durationAreaPerDayMilli` crosses the server/client boundary as a string --
 * a Server Component cannot hand a client one a `bigint` prop -- and
 * `templateTaskOf` below converts it back with `BigInt(...)` before anything
 * calls into `src/lib/schedule/template.ts`. Every other field matches
 * `TemplateTask` there column for column, plus the display-only trade name
 * and resolved rate item code neither pure function needs.
 */
export interface ImportTemplateTaskWire {
  id: string;
  name: string;
  tradeName: string | null;
  sortOrder: number;
  isMilestone: boolean;
  durationBaseDays: number;
  durationSource: DurationSource;
  durationAreaPerDayMilli: string | null;
  durationDaysPerUnit: number | null;
  predecessorTaskId: string | null;
  lagDays: number;
  conditionMeasurement: ConditionMeasurement | null;
  conditionRateItemId: string | null;
  /** Resolved once, in the page, so the sheet never has to look a rate item up to explain itself. */
  conditionRateItemCode: string | null;
}

/** The one conversion the engine needs: the wire shape back to `TemplateTask`. */
export function templateTaskOf(row: ImportTemplateTaskWire): TemplateTask {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    isMilestone: row.isMilestone,
    durationBaseDays: row.durationBaseDays,
    durationSource: row.durationSource,
    durationAreaPerDayMilli:
      row.durationAreaPerDayMilli === null ? null : BigInt(row.durationAreaPerDayMilli),
    durationDaysPerUnit: row.durationDaysPerUnit,
    predecessorTaskId: row.predecessorTaskId,
    lagDays: row.lagDays,
    conditionMeasurement: row.conditionMeasurement,
    conditionRateItemId: row.conditionRateItemId,
  };
}

/**
 * The job's scope evidence, wire-shaped -- section 6.2.
 *
 * `areaSqftMilli` is a string for the reason above. `acceptedQuoteNumbers` and
 * `estimateQuoteNumber` are not read by the engine at all; they exist so the
 * sheet can name the quote a reason is about, the way the spec's own example
 * does: *"No line on QT-2026-0001 carries TILE-SHWR."*
 */
export interface ScopeEvidenceWire {
  hasAcceptedQuote: boolean;
  washroomCount: number;
  kitchenCount: number;
  bedroomCount: number;
  areaSqftMilli: string;
  includedRateItemIds: string[];
  acceptedQuoteNumbers: string[];
  estimateQuoteNumber: string | null;
}

export function scopeEvidenceOf(wire: ScopeEvidenceWire): ScopeEvidence {
  const scope: Scope = {
    areaSqftMilli: BigInt(wire.areaSqftMilli),
    washroomCount: wire.washroomCount,
    kitchenCount: wire.kitchenCount,
    bedroomCount: wire.bedroomCount,
  };
  return {
    scope,
    includedRateItemIds: new Set(wire.includedRateItemIds),
    hasAcceptedQuote: wire.hasAcceptedQuote,
  };
}

/** Every task the evidence suggests, ticked -- the sheet's opening state (section 7.3). */
export function initialTickedIds(
  tasks: readonly ImportTemplateTaskWire[],
  evidence: ScopeEvidence,
): Set<string> {
  const ticked = new Set<string>();
  for (const row of tasks) {
    if (isSuggested(conditionOutcome(templateTaskOf(row), evidence))) ticked.add(row.id);
  }
  return ticked;
}

/** "Excavation and Site survey", never an Oxford comma this product does not use elsewhere. */
function andJoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * A per-row fact, never the paragraph explaining why (section 7.3, and
 * section 9 is explicit that the reasoning stays in the design document).
 * `null` for a matching row -- ticked by default, no grey, nothing to say.
 */
export function templateReasonText(
  outcome: ConditionOutcome,
  ctx: {
    estimateQuoteNumber: string | null;
    acceptedQuoteNumbers: readonly string[];
    conditionRateItemCode: string | null;
  },
): string | null {
  if (isSuggested(outcome)) return null;
  switch (outcome.kind) {
    case 'noAcceptedQuote':
      return 'No accepted quote on this job.';
    case 'measurement':
      return `No ${outcome.measurement} on ${ctx.estimateQuoteNumber ?? 'this quote'}.`;
    case 'rateItem':
      return `No line on ${andJoin(ctx.acceptedQuoteNumbers)} carries ${
        ctx.conditionRateItemCode ?? 'the item this task needs'
      }.`;
    default:
      return null;
  }
}

/**
 * "Drywall will wait on Site survey instead." -- the consequence section 7.4
 * requires be stated, in the same words the spec itself uses. Never shown for
 * an untouched link: the caller only calls this once `relinked` is true.
 */
export function relinkedNote(taskName: string, newPredecessorName: string | null): string {
  return newPredecessorName === null
    ? `${taskName} will start on its own instead.`
    : `${taskName} will wait on ${newPredecessorName} instead.`;
}

/** The fact section 7.4 requires be stated when a negative lag is clamped across a re-link. */
export const LAG_CLAMPED_NOTE = 'The overlap this task had planned is dropped.';
