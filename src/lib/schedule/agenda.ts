import { spansOverlap, type Assignee, type Span } from '@/app/projects/[id]/schedule/schema';
import { assigneeKey } from '@/app/projects/[id]/schedule/clashes';
import { daysBetween, isCalendarDate, shiftDays } from '@/lib/schedule/calendar';

/**
 * The schedule ACROSS EVERY JOB, bucketed by the day it lands on.
 *
 * The owner's words: *"we can use calendar view in high level to show calendar
 * type view with entire schedule showing who is scheduled on what day,
 * internal resource, me, vendor"*.
 *
 * `/projects/[id]/schedule` answers "what order does this job happen in". This
 * module answers the question that screen structurally cannot: **who is on
 * site on Thursday, and is anybody promised to two places at once.** The two
 * halves of a double-booking live on two different job screens, so the one
 * place a clash is naturally invisible is exactly where it costs money.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IMPORTS FROM A ROUTE, WHICH IS BACKWARDS
 * ---------------------------------------------------------------------------
 *
 * `src/lib` depending on `src/app` is the wrong direction and it is deliberate.
 * `spansOverlap` and `assigneeKey` are THE existing answers to "do these two
 * share a day" and "is this the same person" -- written, commented and tested
 * for the per-job screen. A calendar that re-derived either would be a second
 * answer to the same question, and the two would disagree on exactly the edge
 * the first one documents: both ends inclusive, so a one-day milestone still
 * clashes with the five-day task it sits inside.
 *
 * So the dependency points the ugly way rather than the answer being copied.
 * Both imported functions are pure and take no database and no request. Moving
 * them down into `src/lib/schedule/` later is a cut and a paste; a duplicated
 * overlap rule is a bug nobody finds until a sub turns up on the wrong site.
 *
 * ---------------------------------------------------------------------------
 * WHY A TASK IS REPEATED ON EVERY DAY IT COVERS, RATHER THAN DRAWN AS A BAR
 * ---------------------------------------------------------------------------
 *
 * The usual calendar draws a five-day task as one bar spanning five columns.
 * That is rejected here for two reasons, and the first is the smaller one.
 *
 * A spanning bar cannot reflow. A bar that means "Monday to Friday" by its
 * WIDTH means nothing in a stacked, one-column agenda on a phone -- so a bar
 * forces a second render path, one component for the grid and another for the
 * list, which is the drift this codebase has spent days removing.
 *
 * The bigger reason is that the bar answers the wrong question. A bar is about
 * the TASK: when it starts, how long it runs. This screen is about the DAY:
 * who is standing on a site on Thursday. "Excavation, Priya Raghavan" has to be
 * IN Thursday's cell, not inferred from a rectangle that began on Monday --
 * and it has to be there whether the reader is looking at a seven-column grid
 * or scrolling one day at a time on a phone.
 */

/* -------------------------------------------------------------------------
   The period on screen
   ------------------------------------------------------------------------- */

export const PERIODS = ['day', 'week', 'month'] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

/**
 * THE WEEK, and the argument for it over the other two.
 *
 * A DAY cannot show a clash that has not started yet. Excavation runs the 7th
 * to the 11th and the survey the 8th to the 9th; standing on the 7th, the day
 * view is clean and the collision is one tap away and invisible. The screen
 * exists to make a clash impossible to miss, and a period that shows one day
 * can only ever report the clash you are already standing in.
 *
 * A MONTH is a planning instrument, not an operating one. Thirty-one cells on
 * a phone is thirty-one cells of scroll, and at a monitor it answers "where in
 * October is the trouble" -- a real question, asked once a fortnight, not the
 * question this screen is opened with at seven in the morning.
 *
 * A WEEK is the period the owner already thinks in. The job schedule's own
 * summary card says "On site this week", the crew is booked a week out, and
 * seven days is long enough for a clash to be visible before it happens and
 * short enough that every day on screen holds real names rather than a count.
 */
export const DEFAULT_PERIOD: Period = 'week';

/** Anything that is not a period is the default. An unknown value is not an error page. */
export function readPeriod(raw: string | undefined): Period {
  return raw === 'day' || raw === 'month' ? raw : DEFAULT_PERIOD;
}

/**
 * The `period` parameter as a URL carries it: empty for the default.
 *
 * `filterHref` drops empty values, so the week keeps the plain `/schedule`
 * address and only a deliberate choice shows up in the URL. Same reasoning as
 * the pipeline's `viewParam`: a default spelled out in every link is a default
 * that looks like a decision.
 */
export function periodParam(period: Period): string {
  return period === DEFAULT_PERIOD ? '' : period;
}

/* -------------------------------------------------------------------------
   Where in the calendar we are
   ------------------------------------------------------------------------- */

/**
 * A Monday, used to number the days of the week from one.
 *
 * The epoch is a Thursday, so counting weekdays from it puts Sunday at index 3
 * and every off-by-one in this file downstream of that. Naming a real Monday
 * makes `weekdayIndex` readable rather than clever, and `daysBetween` does the
 * arithmetic so no millisecond is ever held here.
 */
const A_MONDAY = '2024-01-01';

/**
 * Monday is 0.
 *
 * **The week starts on Monday, not Sunday.** A consumer calendar in Canada
 * starts on Sunday; a work week does not. Monday-first keeps Saturday and
 * Sunday adjacent at the end of the row, so a weekend reads as one thing --
 * where a Sunday-first row splits it across the two ends and a job running
 * "over the weekend" appears at both edges of the same line.
 */
export function weekdayIndex(isoDate: string): number {
  return ((daysBetween(A_MONDAY, isoDate) % 7) + 7) % 7;
}

/** The Monday of the week this date falls in. */
export function weekStart(isoDate: string): string {
  return shiftDays(isoDate, -weekdayIndex(isoDate));
}

/**
 * The first of the month, by string surgery rather than arithmetic.
 *
 * An ISO date is `YYYY-MM-DD`, so the month is the first eight characters and
 * this adds no day-counting of its own. Every function below that MOVES a date
 * goes through `shiftDays`, per the promise `calendar.ts` makes: turning this
 * product on to working days is that file learning about a calendar, and no
 * other file changing.
 */
export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 8)}01`;
}

/** The first of the following month. Integer arithmetic on the month number only. */
function nextMonthStart(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** The last day of the month this date falls in — the day before the next one starts. */
export function monthEnd(isoDate: string): string {
  return shiftDays(nextMonthStart(isoDate), -1);
}

/**
 * The stretch of days a period covers, from the day the URL is anchored on.
 *
 * Both ends inclusive, matching `planned_start` / `planned_end` and
 * `spansOverlap`. A day period is the same date twice, which is exactly what a
 * milestone is -- so nothing in this file needs a special case for either.
 */
export function rangeOf(period: Period, anchor: string): Span {
  if (period === 'day') return { start: anchor, end: anchor };
  if (period === 'week') {
    const start = weekStart(anchor);
    return { start, end: shiftDays(start, 6) };
  }
  return { start: monthStart(anchor), end: monthEnd(anchor) };
}

/**
 * The anchor one period earlier or later.
 *
 * Normalised to the START of the period rather than kept where the reader
 * happened to be: without that, pressing Next from a Wednesday-anchored week
 * lands on the following Wednesday, and pressing Month afterwards would jump
 * to whichever month that Wednesday fell in. The URL should say a period, and
 * a period is named by its first day.
 */
export function stepAnchor(period: Period, anchor: string, steps: number): string {
  if (period === 'day') return shiftDays(anchor, steps);
  if (period === 'week') return shiftDays(weekStart(anchor), steps * 7);
  let cursor = monthStart(anchor);
  for (let taken = 0; taken < Math.abs(steps); taken += 1) {
    cursor = steps > 0 ? nextMonthStart(cursor) : monthStart(shiftDays(cursor, -1));
  }
  return cursor;
}

/** Every day in a range, in order. Both ends included. */
export function daysOfRange(range: Span): string[] {
  const days: string[] = [];
  const count = daysBetween(range.start, range.end);
  for (let offset = 0; offset <= count; offset += 1) days.push(shiftDays(range.start, offset));
  return days;
}

/**
 * Is this task on site that day?
 *
 * Delegated to `spansOverlap` rather than written as `start <= day && day <= end`,
 * which is the same comparison and would be the second answer this module
 * exists not to have. A single day IS a span whose ends are equal, so the
 * existing predicate answers it unchanged.
 */
export function coversDay(span: Span, isoDay: string): boolean {
  return spansOverlap(span, { start: isoDay, end: isoDay });
}

/**
 * An ISO date the URL may or may not carry. Anything else is today.
 *
 * "Anything else" includes a date that is shaped right and does not exist.
 * A shape check alone let `2026-13-40` through, and because JavaScript rolls
 * a surplus month and day over rather than refusing them, the screen then
 * rendered February 2027 while the URL said something else -- with no error
 * anywhere. `isCalendarDate` is the round-trip that catches it.
 */
export function readAnchor(raw: string | undefined, today: string): string {
  return raw !== undefined && isCalendarDate(raw) ? raw : today;
}

/* -------------------------------------------------------------------------
   What goes in a day
   ------------------------------------------------------------------------- */

/** Somebody who is live on a task: a subcontractor, an internal person, or the owner. */
export interface CalendarAssignee {
  assignee: Assignee;
  /** Already resolved and already suffixed — "(you)", "(retired)". */
  name: string;
}

/** One scheduled task, with the people live on it. Removed assignments never reach here. */
export interface CalendarTask {
  id: string;
  name: string;
  span: Span;
  isMilestone: boolean;
  trade: string | null;
  projectId: string;
  projectNumber: string;
  projectName: string;
  assignees: CalendarAssignee[];
}

/**
 * One line in a day cell: one person on one task, or one task nobody is on.
 *
 * `who === null` is NOT missing data. It is scheduled work with nobody booked
 * against it, which is a fact the owner needs more than most of the rest of
 * this screen -- see `entriesOf`.
 */
export interface DayEntry {
  key: string;
  taskId: string;
  taskName: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  isMilestone: boolean;
  who: string | null;
  /** `vendor:<id>` or `user:<id>`, or null for work nobody is on. */
  assigneeKey: string | null;
  /**
   * The OTHER tasks this person is also on THAT DAY. Empty is the ordinary
   * case; anything in it is a double-booking, and the day is toned for it.
   */
  clashesWith: string[];
  /** False when a filter hides it. Clashes are still counted from hidden rows. */
  visible: boolean;
}

export interface CalendarDay {
  date: string;
  /** Monday is 1, so this drops straight into `grid-column-start`. */
  column: number;
  entries: DayEntry[];
  /** How many people are on two or more tasks this day. */
  clashCount: number;
}

/**
 * Every person on every task, for one day.
 *
 * A task with no live assignee produces ONE entry with no name, and that is a
 * decision rather than a fallthrough. It is the most dangerous row on the
 * screen: work with a date and nobody booked against it is what gets
 * discovered on the morning, and the owner learns about it here or on site.
 * Hiding it behind a control would mean he only sees it when he already
 * suspects -- which is the same failure the double-booking warning exists to
 * prevent. It renders subordinate to a real booking, never absent.
 */
function entriesOf(task: CalendarTask): DayEntry[] {
  if (task.assignees.length === 0) {
    return [
      {
        key: `${task.id}:nobody`,
        taskId: task.id,
        taskName: task.name,
        projectId: task.projectId,
        projectNumber: task.projectNumber,
        projectName: task.projectName,
        isMilestone: task.isMilestone,
        who: null,
        assigneeKey: null,
        clashesWith: [],
        visible: true,
      },
    ];
  }
  return task.assignees.map((person) => ({
    key: `${task.id}:${assigneeKey(person.assignee)}`,
    taskId: task.id,
    taskName: task.name,
    projectId: task.projectId,
    projectNumber: task.projectNumber,
    projectName: task.projectName,
    isMilestone: task.isMilestone,
    who: person.name,
    assigneeKey: assigneeKey(person.assignee),
    clashesWith: [],
    visible: true,
  }));
}

/**
 * What a reader hides, and what the clash arithmetic is allowed to ignore.
 *
 * NOTHING. The predicate marks an entry invisible; it never removes it from
 * the day before the clash is counted, and that is the whole reason the two
 * are separate steps.
 *
 * Filter the calendar to one job and the clash would otherwise disappear --
 * because the framer's OTHER task is on the job that just got filtered out.
 * That is precisely the case the screen was built for, so a clash is always
 * counted across every live job and the warning survives every filter. What a
 * filter changes is which lines are drawn, never whether the collision
 * happened.
 */
export type EntryFilter = (entry: DayEntry) => boolean;

export function buildDays(
  days: readonly string[],
  tasks: readonly CalendarTask[],
  keep?: EntryFilter,
): CalendarDay[] {
  return days.map((date) => {
    const entries: DayEntry[] = [];
    for (const task of tasks) {
      if (!coversDay(task.span, date)) continue;
      entries.push(...entriesOf(task));
    }

    /**
     * The double-booking, found by the day rather than by comparing spans.
     *
     * Two tasks that both reach into this day overlap on it by construction --
     * `coversDay` IS `spansOverlap` against a one-day span -- so grouping the
     * day's entries by person is the same test the job screen runs, asked once
     * per day instead of once per pair. `tests/unit/schedule-agenda.test.ts`
     * holds the two to the same answer.
     */
    const byPerson = new Map<string, DayEntry[]>();
    for (const entry of entries) {
      if (entry.assigneeKey === null) continue;
      const held = byPerson.get(entry.assigneeKey);
      if (held) held.push(entry);
      else byPerson.set(entry.assigneeKey, [entry]);
    }

    let clashCount = 0;
    for (const held of byPerson.values()) {
      if (held.length < 2) continue;
      clashCount += 1;
      for (const entry of held) {
        entry.clashesWith = held
          .filter((other) => other.taskId !== entry.taskId)
          .map((other) => other.taskName);
      }
    }

    if (keep) for (const entry of entries) entry.visible = keep(entry);

    entries.sort(compareEntries);

    return { date, column: weekdayIndex(date) + 1, entries, clashCount };
  });
}

/**
 * A clash first, then by job, then by task, then by name.
 *
 * The trouble goes to the top of the cell because a cell that is busy is a
 * cell somebody skims, and the one line in it that costs money should not be
 * fourth. Everything under it is in a STABLE order -- job then task then
 * person -- so the same day read twice reads the same, and a name does not
 * move between two visits because a status changed somewhere else.
 */
function compareEntries(a: DayEntry, b: DayEntry): number {
  const clash = Number(b.clashesWith.length > 0) - Number(a.clashesWith.length > 0);
  if (clash !== 0) return clash;
  if (a.projectNumber !== b.projectNumber) return a.projectNumber < b.projectNumber ? -1 : 1;
  if (a.taskName !== b.taskName) return a.taskName < b.taskName ? -1 : 1;
  // Work nobody is on sorts last within its task, so a real booking is read first.
  if (a.who === null) return b.who === null ? 0 : 1;
  if (b.who === null) return -1;
  return a.who < b.who ? -1 : a.who > b.who ? 1 : 0;
}

/* -------------------------------------------------------------------------
   What the screen says about the whole period
   ------------------------------------------------------------------------- */

export interface CalendarSummary {
  /** Lines actually drawn, after filtering. What the count line reports. */
  shown: number;
  /** Scheduled work in the period with nobody booked against it. */
  unassigned: number;
  /** One per person per day. Two people clashing on one day is two. */
  clashes: number;
  /** The first day holding a clash, for the link out of the warning. */
  firstClashDay: string | null;
  /** The worst one, said in a sentence: who, when, and the tasks. */
  worst: { who: string; date: string; taskNames: string[] } | null;
}

export function summarize(days: readonly CalendarDay[]): CalendarSummary {
  let shown = 0;
  let unassigned = 0;
  let clashes = 0;
  let firstClashDay: string | null = null;
  let worst: CalendarSummary['worst'] = null;

  for (const day of days) {
    clashes += day.clashCount;
    if (day.clashCount > 0 && firstClashDay === null) firstClashDay = day.date;
    for (const entry of day.entries) {
      if (!entry.visible) continue;
      shown += 1;
      if (entry.who === null) unassigned += 1;
      if (worst === null && entry.clashesWith.length > 0 && entry.who !== null) {
        worst = {
          who: entry.who,
          date: day.date,
          taskNames: [entry.taskName, ...entry.clashesWith],
        };
      }
    }
    // A clash whose lines are all filtered away still has to produce a
    // sentence, or narrowing to one job would silence the very warning that
    // job's screen cannot give.
    if (worst === null && day.clashCount > 0) {
      const clashing = day.entries.find((entry) => entry.clashesWith.length > 0 && entry.who !== null);
      if (clashing) {
        worst = {
          who: clashing.who!,
          date: day.date,
          taskNames: [clashing.taskName, ...clashing.clashesWith],
        };
      }
    }
  }

  return { shown, unassigned, clashes, firstClashDay, worst };
}
