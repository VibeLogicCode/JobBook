import { z } from 'zod';
import type { FieldError } from '@/app/settings/result';
import { isoDate, optionalText, requiredText } from '@/app/settings/validate';
import { durationDays } from '@/lib/schedule/calendar';
import type { HeldTask, TaskMove } from '@/lib/schedule/push';
import type { Tone } from '@/components/ui/Pill';

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
  trade: 'Trade',
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
  trade: optionalText(120),
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
