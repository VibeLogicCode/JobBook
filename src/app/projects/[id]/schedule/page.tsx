import { and, asc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import {
  assignments,
  costCodes,
  organization,
  projects,
  scheduleTasks,
  trades,
  users,
  vendors,
} from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { listOptionLabel } from '@/app/settings/vendor-lists';
import { can } from '@/lib/auth/permissions';
import { formatCents } from '@/lib/money/format';
import { addDays, tenantToday } from '@/lib/quote/dates';
import { latestDate } from '@/lib/schedule/calendar';
import {
  PERIOD_LABELS,
  buildDays,
  daysOfRange,
  periodParam,
  rangeOf,
  readAnchor,
  readPeriod,
  summarize,
  type CalendarDay,
  type CalendarSummary,
  type CalendarTask,
  type EntryFilter,
} from '@/lib/schedule/agenda';
import { findPredecessorCycle, type ScheduleTask } from '@/lib/schedule/push';
import { nameOf, readRoster } from '@/lib/schedule/roster';
import {
  assignToTask,
  createTask,
  removeAssignment,
  updateAssignment,
} from '@/app/projects/[id]/schedule/actions';
import {
  ASSIGNMENT_RESPONSES,
  RESPONSE_LABELS,
  STATUS_LABELS,
  assigneeValue,
  centsToInput,
  clashPillLabel,
  dayFormatter,
  durationLabel,
  momentFormatter,
  overlapDays,
  responseOf,
  responseTone,
  statusTone,
  waitsOnLabel,
  type Assignee,
  type Clash,
  type Span,
  type TaskStatus,
} from '@/app/projects/[id]/schedule/schema';
import {
  assigneeKey,
  findEngagements,
  groupEngagements,
  toClash,
  type Engagement,
} from '@/app/projects/[id]/schedule/clashes';
import {
  WhoSheet,
  type AssignmentView,
} from '@/app/projects/[id]/schedule/WhoSheet';
import { ActionForm } from '@/components/settings/ActionForm';
import {
  CheckboxField,
  FieldGrid,
  TextAreaField,
  TextField,
  type Option,
} from '@/components/settings/Fields';
import { CalendarGrid } from '@/components/schedule/CalendarGrid';
import { PeriodNav } from '@/components/schedule/PeriodNav';
import { TaskEditor, TaskFields } from '@/components/schedule/TaskEditor';
import { TaskSheet } from '@/components/schedule/TaskSheet';
import { readScheduleView, scheduleHref, SCHEDULE_VIEWS, viewParam } from '@/components/schedule/view';
import { Card } from '@/components/ui/Card';
import { filterHref } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/ui/MetricCard';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { SegmentedLinks } from '@/components/ui/SegmentedLinks';
import { SheetButton } from '@/components/ui/Sheet';
import { TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read this schedule but not change it.';

type TaskRow = typeof scheduleTasks.$inferSelect;

/** A search parameter as one value. A repeated parameter is the first one. */
function one(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
}

/** "Excavation, Site survey and Kitchen rough-in" — the clash warning's list of tasks. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The order the work happens in, for one job.
 *
 * **A list ordered by planned date, and no Gantt.** Spec 5.2 cut the timeline
 * renderer explicitly and the reasoning holds: a list plus the dates answers
 * every question the owner actually asked -- who is on site this week, what is
 * late, what does this delay push out -- without a custom chart to maintain
 * across three breakpoints, and a bar chart of a fifteen-task schedule on a
 * phone is a bar chart nobody reads. What replaces the drag is two date boxes
 * and a confirmation that names what goes with them, which is the interaction
 * the plan says matters most.
 *
 * **Why it is a route under the job rather than a screen of its own.** A
 * schedule is not a list of tasks across the company; it is one job's order of
 * work, and every question asked of it -- what is late, when does this finish
 * -- is asked about that job. The URL says so, and the job's own screen links
 * here.
 *
 * **`?view=calendar` is the same question asked a different way, never a
 * different answer.** The owner asked for a way to switch this table to the
 * calendar the way `/projects` switches between board and list -- see
 * `components/schedule/view.ts`. The list default is untouched by any of it:
 * this table, its columns and its rows render exactly as they did before a
 * reader who never presses the toggle would see. The calendar reads every
 * live task in the period ACROSS EVERY JOB, exactly the way `/calendar` does
 * and for the same reason -- a double-booking's other half is on another
 * job's screen, and `buildDays` only counts a clash it was handed. This
 * screen then narrows to its OWN job with an `EntryFilter`, after the clash
 * arithmetic has already run, so a sub double-booked between this job and
 * another is still named in the warning even though the other job's line is
 * never drawn.
 */
export default async function SchedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: projectId } = await params;
  const query = await searchParams;
  const showVoided = one(query.voided) === '1';
  const view = readScheduleView(one(query.view));

  const [project] = await db
    .select({
      id: projects.id,
      projectNumber: projects.projectNumber,
      name: projects.name,
      stage: projects.stage,
      recordStatus: projects.recordStatus,
    })
    .from(projects)
    .where(eq(projects.id, projectId));

  if (!project) notFound();

  const [org] = await db
    .select({ locale: organization.locale, timezone: organization.timezone })
    .from(organization);
  const locale = org?.locale ?? 'en-CA';
  const day = dayFormatter(locale);
  // A confirmation is an instant, not a calendar day, so it is rendered in the
  // tenant's own zone. See the note on `momentFormatter`.
  const moment = momentFormatter(locale, org?.timezone ?? 'UTC');
  // The tenant's own date, from the database. `new Date()` in a UTC container
  // reads as tomorrow from early evening, which would mark a task late a day
  // before it is -- and the person reading the screen is the one who has to
  // explain that to a crew.
  const today = await db.transaction((tx) => tenantToday(tx));
  const weekEnd = addDays(today, 6);

  // Read regardless of which view is on screen -- cheap, pure, and it keeps
  // the calendar's own defaults (this week, today) ready the moment the
  // toggle is pressed rather than only after a page it was never on.
  const period = readPeriod(one(query.period) || undefined);
  const anchor = readAnchor(one(query.on) || undefined, today);
  const range = rangeOf(period, anchor);

  const state = await resolveActor();
  // A voided job's schedule stays readable -- it is the record of what was
  // planned -- and stops being editable. The actions refuse it too, because a
  // disabled control is a hint and neither a stale tab nor a hand-made POST is
  // obliged to read one.
  const jobIsVoid = project.recordStatus === 'void';
  const allowed = state.actor ? can(state.actor.role, 'quote:write') && !jobIsVoid : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') && !jobIsVoid : false;

  const all = await db
    .select()
    .from(scheduleTasks)
    .where(eq(scheduleTasks.projectId, projectId))
    .orderBy(asc(scheduleTasks.plannedStart), asc(scheduleTasks.sortOrder), asc(scheduleTasks.name));

  const live = all.filter((row) => row.recordStatus !== 'void');
  const voided = all.filter((row) => row.recordStatus === 'void');
  const rows = showVoided ? all : live;
  const nameById = new Map(all.map((row) => [row.id, row.name]));

  /** The set the push reads, so the picker and the action agree on the graph. */
  const graph: ScheduleTask[] = live.map((row) => ({
    id: row.id,
    name: row.name,
    plannedStart: row.plannedStart,
    plannedEnd: row.plannedEnd,
    actualStart: row.actualStart,
    actualEnd: row.actualEnd,
    predecessorTaskId: row.predecessorTaskId,
    lagDays: row.lagDays,
  }));

  const finish = latestDate(live.map((row) => row.plannedEnd));
  const isLate = (row: TaskRow) =>
    row.status !== 'complete' && row.actualEnd === null && row.plannedEnd < today;
  const lateCount = live.filter(isLate).length;
  const thisWeek = live.filter(
    (row) => row.plannedStart <= weekEnd && row.plannedEnd >= today && row.status !== 'complete',
  );

  const allCodes = await db
    .select({
      id: costCodes.id,
      code: costCodes.code,
      name: costCodes.name,
      isActive: costCodes.isActive,
    })
    .from(costCodes)
    .where(ne(costCodes.recordStatus, 'void'))
    .orderBy(asc(costCodes.code));

  const codeById = new Map(allCodes.map((row) => [row.id, row]));

  // Every trade, retired and voided included. A task already pointing at a
  // retired one has to go on displaying it -- retiring "Roofing" must not
  // blank the row -- and a select whose `defaultValue` matches no option
  // silently shows the FIRST one instead, which the next save would then
  // write back as the task's trade.
  const allTrades = await db
    .select()
    .from(trades)
    .orderBy(asc(trades.sortOrder), asc(trades.name));

  const tradeById = new Map(allTrades.map((row) => [row.id, row]));

  /* -----------------------------------------------------------------------
     Who is on each task
     ----------------------------------------------------------------------- */

  const taskIds = all.map((row) => row.id);

  /**
   * Every assignment on this job, with the assignee's name resolved.
   *
   * TWO LEFT JOINS, and both of them unconditional. Exactly one of `vendor_id`
   * and `user_id` is set on any row -- the database holds that -- so exactly
   * one join produces a name and the other produces nulls.
   *
   * Neither join filters on `is_active` or on `record_status`, and that is the
   * whole reason a retired vendor goes on reading. The column is a foreign key
   * to a row that is never deleted, so the name always resolves; what changes
   * when somebody is retired is that the PICKER stops offering them, which is a
   * different query entirely. Filtering here instead would blank last spring's
   * schedule the afternoon a sub was retired.
   */
  const assignmentRows =
    taskIds.length === 0
      ? []
      : await db
          .select({
            id: assignments.id,
            scheduleTaskId: assignments.scheduleTaskId,
            vendorId: assignments.vendorId,
            userId: assignments.userId,
            confirmedAt: assignments.confirmedAt,
            declinedAt: assignments.declinedAt,
            agreedAmountCents: assignments.agreedAmountCents,
            notes: assignments.notes,
            removedAt: assignments.removedAt,
            removalReason: assignments.removalReason,
            createdAt: assignments.createdAt,
            vendorName: vendors.name,
            vendorIsActive: vendors.isActive,
            vendorStatus: vendors.recordStatus,
            userName: users.displayName,
            userIsActive: users.isActive,
          })
          .from(assignments)
          .leftJoin(vendors, eq(vendors.id, assignments.vendorId))
          .leftJoin(users, eq(users.id, assignments.userId))
          .where(
            and(
              inArray(assignments.scheduleTaskId, taskIds),
              // A voided assignment is one that should never have existed.
              // Being taken off a task is `removed_at`, and those rows stay on
              // screen with their reason.
              ne(assignments.recordStatus, 'void'),
            ),
          )
          .orderBy(asc(assignments.createdAt));

  type AssignmentRow = (typeof assignmentRows)[number];

  const assigneeOf = (row: AssignmentRow): Assignee =>
    row.vendorId !== null
      ? { kind: 'vendor', id: row.vendorId }
      : { kind: 'user', id: row.userId! };

  /**
   * What to call them, and what the reader has to know about their standing.
   *
   * The suffix is not decoration. A sub who was retired last month is still on
   * this task and the row still has to read -- but somebody looking at the
   * schedule needs to know before they ring him, and a name with nothing beside
   * it says he is on the list when he is not.
   */
  function assigneeName(row: AssignmentRow): string {
    if (row.vendorId !== null) {
      const name = row.vendorName ?? 'A vendor that is no longer readable';
      if (row.vendorStatus === 'void') return `${name} (voided vendor)`;
      if (row.vendorIsActive === false) return `${name} (retired)`;
      return name;
    }
    const name = row.userName ?? 'Somebody who is no longer readable';
    if (row.userId === state.actor?.id) return `${name} (you)`;
    if (row.userIsActive === false) return `${name} (deactivated)`;
    return name;
  }

  const byTask = new Map<string, AssignmentRow[]>();
  for (const row of assignmentRows) {
    const list = byTask.get(row.scheduleTaskId);
    if (list) list.push(row);
    else byTask.set(row.scheduleTaskId, [row]);
  }
  const liveFor = (taskId: string) =>
    (byTask.get(taskId) ?? []).filter((row) => row.removedAt === null);

  /**
   * WHERE ELSE these people are booked -- one query for the whole screen.
   *
   * The window is this job's own span, so a sub's work in another year is not
   * read at all; `spansOverlap` then does the pairing, per row, in memory.
   */
  const spanOf = (row: TaskRow): Span => ({ start: row.plannedStart, end: row.plannedEnd });
  const jobWindow: Span | null =
    live.length === 0
      ? null
      : {
          start: live.reduce((a, row) => (row.plannedStart < a ? row.plannedStart : a), live[0]!.plannedStart),
          end: live.reduce((a, row) => (row.plannedEnd > a ? row.plannedEnd : a), live[0]!.plannedEnd),
        };

  const engagementsByAssignee: Map<string, Engagement[]> =
    jobWindow === null
      ? new Map()
      : groupEngagements(
          await findEngagements(
            db,
            assignmentRows.filter((row) => row.removedAt === null).map(assigneeOf),
            jobWindow,
          ),
        );

  /** The other tasks this assignment's person is on over the days this one runs. */
  function clashesFor(row: AssignmentRow, span: Span): Clash[] {
    if (row.removedAt !== null) return [];
    return (engagementsByAssignee.get(assigneeKey(assigneeOf(row))) ?? [])
      .filter((engagement) => engagement.taskId !== row.scheduleTaskId)
      .map((engagement) => toClash(engagement, overlapDays(span, engagement.span)))
      .filter((clash) => clash.days > 0);
  }

  /**
   * Who may be put on a task.
   *
   * Subcontractors only, and live ones: `is_subcontractor` is the column that
   * says this counterparty performs work rather than selling goods, and a
   * lumber yard is not assigned to a task. Retired and voided rows are absent
   * because retiring means "do not offer this on new work" -- which is exactly
   * what this list is -- and the action re-checks all of it inside its own
   * transaction, because this list was built before the button was pressed.
   *
   * Internal people are `users` rows, the owner among them. He is offered
   * first and labelled, because "me" is the commonest answer on a small job and
   * because it is the answer a magic string would otherwise have been invented
   * for.
   */
  const subcontractors = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(
      and(
        eq(vendors.isSubcontractor, true),
        eq(vendors.isActive, true),
        ne(vendors.recordStatus, 'void'),
      ),
    )
    .orderBy(asc(vendors.name));

  const internal = await db
    .select({ id: users.id, name: users.displayName })
    .from(users)
    .where(and(eq(users.isActive, true), ne(users.recordStatus, 'void')))
    .orderBy(asc(users.displayName));

  const assigneeOptions: Option[] = [
    ...internal
      // The signed-in person first: on a job this size the answer is usually
      // "me", and a picker that buries it costs a scroll every time.
      .slice()
      .sort((a, b) => Number(b.id === state.actor?.id) - Number(a.id === state.actor?.id))
      .map((person) => ({
        value: assigneeValue('user', person.id),
        label:
          person.id === state.actor?.id
            ? `You — ${person.name}`
            : `Internal — ${person.name}`,
      })),
    ...subcontractors.map((vendor) => ({
      value: assigneeValue('vendor', vendor.id),
      label: `Subcontractor — ${vendor.name}`,
    })),
  ];

  const responseOptions: Option[] = ASSIGNMENT_RESPONSES.map((value) => ({
    value,
    label: RESPONSE_LABELS[value],
  }));

  /**
   * One task's assignments, with every string resolved HERE.
   *
   * The sheet is a client component -- it has to be, because the primary action
   * is pinned in the panel footer and only `Sheet` itself offers one -- so
   * nothing crosses that boundary except plain data. Formatting money, naming a
   * retired vendor and rendering a confirmation in the tenant's zone all stay on
   * this side, where the locale and the timezone already are.
   */
  function assignmentViews(task: TaskRow): AssignmentView[] {
    const taskSpan = spanOf(task);
    return (byTask.get(task.id) ?? []).map((assignment) => {
      const response = responseOf(assignment);
      const clashes = clashesFor(assignment, taskSpan);
      return {
        id: assignment.id,
        name: assigneeName(assignment),
        response,
        responseLabel: RESPONSE_LABELS[response],
        responseTone: responseTone(response),
        amount:
          assignment.agreedAmountCents === null
            ? null
            : `${formatCents(assignment.agreedAmountCents)} agreed`,
        amountInput:
          assignment.agreedAmountCents === null
            ? ''
            : centsToInput(assignment.agreedAmountCents),
        notes: assignment.notes,
        answeredOn: assignment.confirmedAt
          ? `Confirmed ${moment(assignment.confirmedAt)}`
          : assignment.declinedAt
            ? `Said no ${moment(assignment.declinedAt)}`
            : null,
        removed:
          assignment.removedAt === null
            ? null
            : {
                on: `Taken off ${moment(assignment.removedAt)}`,
                reason: assignment.removalReason ?? 'no reason was recorded',
              },
        clashes: clashes.map((clash) => ({
          projectId: clash.projectId,
          projectNumber: clash.projectNumber,
          taskName: clash.taskName,
          days: clash.days,
        })),
        clashLabel: clashes.length > 0 ? clashPillLabel(clashes, project.id) : null,
      };
    });
  }

  function costCodeOptions(row?: TaskRow): Option[] {
    const options: Option[] = allCodes.map((code) => ({
      value: code.id,
      label: `${code.code} — ${code.name}${code.isActive ? '' : ' (retired)'}`,
    }));
    // A select whose defaultValue matches no option silently shows the first
    // one instead, and the next save would recode the task to whatever sorted
    // first.
    if (row?.costCodeId && !codeById.has(row.costCodeId)) {
      options.push({ value: row.costCodeId, label: 'The code this was set to (now void)' });
    }
    return options;
  }

  /**
   * The trades a task may be pointed at: the ones still on the list, plus
   * whichever one this task already carries, marked.
   *
   * A retired trade is not offered to a task that is not already on it --
   * retired means do not offer this on new work -- but it IS offered back to
   * the task that is, for the reason `costCodeOptions` gives: a select whose
   * `defaultValue` matches no option silently shows the first one instead.
   */
  function tradeOptions(row?: TaskRow): Option[] {
    const options: Option[] = allTrades
      .filter((trade) => trade.isActive && trade.recordStatus === 'active')
      .map((trade) => ({ value: trade.id, label: trade.name }));

    const current = row?.tradeId ? tradeById.get(row.tradeId) : undefined;
    if (current && !options.some((option) => option.value === current.id)) {
      options.push({ value: current.id, label: listOptionLabel(current) });
    }
    return options;
  }

  /**
   * What a task may be told to wait on.
   *
   * Everything live except itself and except anything that already reaches it
   * through the chain -- because pointing at one of those would close a loop.
   * The filter is `findPredecessorCycle`, the same function the action uses
   * inside its transaction, so the picker cannot offer something the save
   * would then refuse. The action still checks: this list was built before the
   * button was pressed, and a second tab does not read it.
   */
  function predecessorOptions(row?: TaskRow): Option[] {
    return graph
      .filter((task) => {
        if (!row) return true;
        if (task.id === row.id) return false;
        return findPredecessorCycle(graph, row.id, task.id) === null;
      })
      .map((task) => ({
        value: task.id,
        label: `${task.name} — ends ${day(task.plannedEnd)}`,
      }));
  }

  const shownCount = rows.length;

  /* -----------------------------------------------------------------------
     The calendar view: every live task in the period, across every job.
     Skipped entirely on the list default, which is the common path and must
     stay exactly as fast as it already is.
     ----------------------------------------------------------------------- */

  let calendarDays: CalendarDay[] = [];
  let calendarSummary: CalendarSummary = {
    shown: 0,
    unassigned: 0,
    clashes: 0,
    firstClashDay: null,
    worst: null,
  };
  let openTask: TaskRow | null = null;
  let openOnIt: string[] = [];

  if (view === 'calendar') {
    const openTaskId = one(query.task);
    // Scoped to `all` -- this job's own tasks -- rather than read by id from
    // the whole table. Only an entry this job's own calendar drew is ever
    // tappable (see `keep` below), so a task on another job never reaches
    // this URL through the UI; reading it from `all` refuses one that did
    // by hand, the same way a stale or hand-edited id refuses quietly rather
    // than 500ing.
    openTask = all.find((row) => row.id === openTaskId) ?? null;
    openOnIt = openTask ? liveFor(openTask.id).map((row) => assigneeName(row)) : [];

    const calendarRows = await db
      .select({
        taskId: scheduleTasks.id,
        taskName: scheduleTasks.name,
        plannedStart: scheduleTasks.plannedStart,
        plannedEnd: scheduleTasks.plannedEnd,
        isMilestone: scheduleTasks.isMilestone,
        // The name, not the id -- `CalendarTask.trade` is a display string, and
        // a retired trade still has to resolve here the same way it does on
        // this job's own table.
        trade: trades.name,
        projectId: projects.id,
        projectNumber: projects.projectNumber,
        projectName: projects.name,
        vendorId: assignments.vendorId,
        userId: assignments.userId,
      })
      .from(scheduleTasks)
      .innerJoin(projects, eq(projects.id, scheduleTasks.projectId))
      .leftJoin(trades, eq(trades.id, scheduleTasks.tradeId))
      .leftJoin(
        assignments,
        and(
          eq(assignments.scheduleTaskId, scheduleTasks.id),
          // A removed assignment is not a booking, and neither is a voided one.
          isNull(assignments.removedAt),
          ne(assignments.recordStatus, 'void'),
        ),
      )
      .where(
        and(
          // Every live job, not just this one -- see the docblock above this
          // component and `EntryFilter` in `agenda.ts`. Narrowing here would
          // make a clash with another job disappear along with that job's row.
          ne(scheduleTasks.recordStatus, 'void'),
          ne(projects.recordStatus, 'void'),
          // Both ends inclusive, matching `plannedStart`/`plannedEnd` and
          // `spansOverlap`: a one-day milestone still overlaps the week it sits in.
          lte(scheduleTasks.plannedStart, range.end),
          gte(scheduleTasks.plannedEnd, range.start),
        ),
      )
      .orderBy(asc(scheduleTasks.plannedStart), asc(projects.projectNumber), asc(scheduleTasks.name));

    // The one helper that knows a vendor from a user, same as `/calendar`.
    // This job's own `assigneeName` above cannot be reused here: it only
    // resolves names for assignments already read for THIS job, and a
    // cross-job clash needs to name somebody booked on a task this screen
    // never queried for its own rows.
    const calendarRoster = await readRoster(db, state.actor?.id ?? null);

    const byCalendarTask = new Map<string, CalendarTask>();
    for (const row of calendarRows) {
      let task = byCalendarTask.get(row.taskId);
      if (!task) {
        task = {
          id: row.taskId,
          name: row.taskName,
          span: { start: row.plannedStart, end: row.plannedEnd },
          isMilestone: row.isMilestone,
          trade: row.trade,
          projectId: row.projectId,
          projectNumber: row.projectNumber,
          projectName: row.projectName,
          assignees: [],
        };
        byCalendarTask.set(row.taskId, task);
      }
      const assignee: Assignee | null =
        row.vendorId !== null
          ? { kind: 'vendor', id: row.vendorId }
          : row.userId !== null
            ? { kind: 'user', id: row.userId }
            : null;
      if (assignee) task.assignees.push({ assignee, name: nameOf(calendarRoster, assignee) });
    }

    /**
     * This job's own narrowing, applied to `buildDays`'s output rather than
     * to the query above -- exactly what makes a double-booking with another
     * job still get counted and still get named even though its line is
     * never drawn on this job's calendar.
     */
    const keep: EntryFilter = (entry) => entry.projectId === project.id;
    calendarDays = buildDays(daysOfRange(range), [...byCalendarTask.values()], keep);
    calendarSummary = summarize(calendarDays);
  }

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <Link href={`/projects/${project.id}`} className="underline">
              {project.projectNumber}
            </Link>
            <span className="text-muted">{project.name}</span>
            {project.recordStatus === 'void' ? <Pill tone="negative">Void</Pill> : null}
          </span>
        }
        title="Schedule"
        description="A task can wait on one other task; move it and everything behind shifts too."
        actions={
          <SheetButton
            trigger="Add task"
            variant="primary"
            label="Add a task to this schedule"
            title="Add a task"
            subtitle={project.name}
            discardPrompt="Throw away this task? Nothing has been saved yet."
          >
            <ActionForm
              action={createTask}
              submitLabel="Add task"
              disabled={!allowed}
              disabledNote={state.actor ? REFUSAL : (state.reason ?? undefined)}
              resetOnSuccess
            >
              <input type="hidden" name="projectId" value={project.id} />
              <FieldGrid>
                <TaskFields
                  idPrefix="new-task"
                  disabled={!allowed}
                  tradeOptions={tradeOptions()}
                  costCodeOptions={costCodeOptions()}
                  predecessorOptions={predecessorOptions()}
                />
                <TextField
                  idPrefix="new-task"
                  name="plannedStart"
                  label="Starts"
                  type="date"
                  required
                  defaultValue={today}
                  disabled={!allowed}
                />
                <TextField
                  idPrefix="new-task"
                  name="plannedEnd"
                  label="Finishes"
                  type="date"
                  required
                  defaultValue={today}
                  disabled={!allowed}
                  hint="Inclusive — same date twice is one day. Weekends count."
                />
                <CheckboxField
                  idPrefix="new-task"
                  name="isMilestone"
                  label="This is a milestone, not a span of work"
                  disabled={!allowed}
                  wide
                  hint="A permit, inspection or delivery — one day, not a span. Finish date matches start."
                />
              </FieldGrid>
              <TextAreaField
                idPrefix="new-task"
                name="notes"
                label="Notes"
                rows={2}
                disabled={!allowed}
              />
            </ActionForm>
          </SheetButton>
        }
      />

      {state.actor ? null : (
        <div className="mb-3">
          <Notice tone="warning">{state.reason}</Notice>
        </div>
      )}

      {live.length > 0 ? (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricCard
            label="Job finishes"
            from="the latest planned finish"
            value={finish ? day(finish) : '—'}
            secondary={`${live.length} ${live.length === 1 ? 'task' : 'tasks'} planned`}
          />
          <MetricCard
            label="On site this week"
            from={`${day(today)} to ${day(weekEnd)}`}
            value={String(thisWeek.length)}
            secondary={
              thisWeek.length === 0
                ? 'Nothing planned in the next seven days'
                : thisWeek.map((row) => row.name).join(', ')
            }
          />
          <MetricCard
            label="Late"
            from="planned finish against today"
            value={String(lateCount)}
            secondary={
              lateCount === 0
                ? 'Nothing has run past its planned finish'
                : 'Past their planned finish and not marked complete'
            }
          />
        </div>
      ) : null}

      {/* ABOVE the table, not below it, which is where this line used to sit
          when it only reported voided tasks. A schedule is as long as the job
          is, so a control at the foot of it is a control found by scrolling
          past everything it changes -- and the owner asked for this toggle
          while looking at the top of the screen. The pipeline's count line
          precedes its content for the same reason.

          Always rendered now, so the toggle has a home. Its voided link stays
          conditional: a reveal with nothing behind it answers a question
          nobody asked. */}
      <p className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 t-small text-subtle">
        {voided.length > 0 ? (
          <Link
            href={filterHref(`/projects/${project.id}/schedule`, {
              view: viewParam(view),
              voided: showVoided ? '' : '1',
            })}
            className="underline"
          >
            {showVoided
              ? `Hide the ${voided.length} voided ${voided.length === 1 ? 'task' : 'tasks'}`
              : `Show ${voided.length} voided ${voided.length === 1 ? 'task' : 'tasks'}`}
          </Link>
        ) : null}
        <span>
          {shownCount} {shownCount === 1 ? 'task' : 'tasks'} on screen
        </span>
        <SegmentedLinks
          ariaLabel="How the schedule is drawn"
          options={SCHEDULE_VIEWS.map((entry) => ({
            href: scheduleHref(
              `/projects/${project.id}/schedule`,
              { voided: showVoided ? '1' : '' },
              entry.view,
            ),
            label: entry.label,
            active: entry.view === view,
          }))}
        />
      </p>

      {view === 'calendar' ? (
        <>
          {/* Survives every filter -- there are none on this screen besides
              the job itself -- for the same reason `/calendar`'s does:
              `summarize` counts a clash from a hidden line too. */}
          {calendarSummary.worst ? (
            <Notice
              tone="warning"
              role="status"
              className="mb-3"
              title={`${calendarSummary.clashes} double-booking${calendarSummary.clashes === 1 ? '' : 's'}`}
            >
              <p>
                {calendarSummary.worst.who} is on {andList(calendarSummary.worst.taskNames)} on{' '}
                {day(calendarSummary.worst.date)}.
              </p>
            </Notice>
          ) : null}

          <PeriodNav
            basePath={`/projects/${project.id}/schedule`}
            carry={{ view: viewParam(view) }}
            period={period}
            anchor={anchor}
            today={today}
            locale={locale}
            extra={
              calendarSummary.unassigned > 0 ? (
                <span className="t-small text-muted">
                  {calendarSummary.unassigned} with nobody booked
                </span>
              ) : null
            }
          />

          {calendarSummary.shown === 0 ? (
            <Card as="div" className="mb-3 p-6 text-muted">
              Nothing is scheduled in this {PERIOD_LABELS[period].toLowerCase()}.
            </Card>
          ) : null}

          <CalendarGrid
            days={calendarDays}
            columns={period === 'day' ? 1 : 7}
            locale={locale}
            today={today}
            taskHref={(taskId) =>
              filterHref(`/projects/${project.id}/schedule`, {
                view: viewParam(view),
                period: periodParam(period),
                on: anchor === today ? '' : anchor,
                task: taskId,
              })
            }
          />
        </>
      ) : rows.length === 0 ? (
        <Card as="div" className="p-6 text-muted">
          {voided.length > 0 && !showVoided
            ? 'Every task on this schedule has been voided. Nothing has been lost — the control below brings them back into view.'
            : 'No tasks yet. Add the work in the order you will do it, and mark the ones that wait on something else. A task that waits on nothing keeps its date whatever happens around it.'}
        </Card>
      ) : (
        <TableWrap minWidth="72rem">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col">Who</th>
              <th scope="col">Waits on</th>
              <th scope="col">Planned</th>
              <th scope="col">Actual</th>
              <th scope="col">Status</th>
              <th scope="col">Manage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isVoid = row.recordStatus === 'void';
              const code = row.costCodeId ? codeById.get(row.costCodeId) : undefined;
              const trade = row.tradeId ? tradeById.get(row.tradeId) : undefined;
              const predecessorName = row.predecessorTaskId
                ? (nameById.get(row.predecessorTaskId) ?? 'a task that is no longer here')
                : null;
              const late = isLate(row) && !isVoid;
              const span = spanOf(row);
              const onIt = liveFor(row.id);

              return (
                <tr key={row.id}>
                  <td data-label="Task">
                    {row.name}
                    <span className="block t-small text-subtle">
                      {[trade?.name, code ? `${code.code} — ${code.name}` : null]
                        .filter(Boolean)
                        .join(' · ') || 'No trade recorded'}
                    </span>
                  </td>
                  <td data-label="Who" className="t-small">
                    {onIt.length === 0 ? (
                      // Said in words rather than left blank, for the reason
                      // "Stands alone" is: a blank reads as missing data, and
                      // this one is a question nobody has answered yet.
                      <span className="text-subtle">Nobody yet</span>
                    ) : (
                      onIt.map((assignment) => {
                        const response = responseOf(assignment);
                        const clashes = clashesFor(assignment, span);
                        return (
                          <span key={assignment.id} className="mb-1 block last:mb-0">
                            <span className="block">{assigneeName(assignment)}</span>
                            <span className="flex flex-wrap items-center gap-1">
                              <Pill tone={responseTone(response)}>{RESPONSE_LABELS[response]}</Pill>
                              {clashes.length > 0 ? (
                                // The double-booking, said where it stays said.
                                // The other task is on another job's screen, so
                                // this row is the only place it can be seen.
                                <Pill tone="warning">{clashPillLabel(clashes, project.id)}</Pill>
                              ) : null}
                            </span>
                          </span>
                        );
                      })
                    )}
                  </td>
                  <td data-label="Waits on" className="t-small text-muted">
                    {predecessorName === null ? (
                      // Said in words rather than left blank. A blank here
                      // reads as missing data; "stands alone" is the promise
                      // that this date never moves on its own.
                      'Stands alone'
                    ) : (
                      <>
                        <span className="block">{predecessorName}</span>
                        <span className="block t-small text-subtle">
                          {waitsOnLabel(predecessorName, row.lagDays)}
                        </span>
                      </>
                    )}
                  </td>
                  <td data-label="Planned" className="t-small">
                    <span className="num block">
                      {row.isMilestone
                        ? day(row.plannedStart)
                        : `${day(row.plannedStart)} – ${day(row.plannedEnd)}`}
                    </span>
                    <span className="block t-small text-subtle">
                      {row.isMilestone ? 'Milestone' : durationLabel(row.plannedStart, row.plannedEnd)}
                    </span>
                  </td>
                  <td data-label="Actual" className="t-small text-muted">
                    {row.actualStart === null ? (
                      'Not started'
                    ) : (
                      <span className="num">
                        {day(row.actualStart)}
                        {row.actualEnd ? ` – ${day(row.actualEnd)}` : ' – ongoing'}
                      </span>
                    )}
                  </td>
                  <td data-label="Status">
                    <span className="flex flex-wrap items-center gap-1">
                      {isVoid ? <Pill tone="negative">Void</Pill> : null}
                      {isVoid ? null : (
                        <Pill tone={statusTone(row.status as TaskStatus)}>
                          {STATUS_LABELS[row.status as TaskStatus]}
                        </Pill>
                      )}
                      {late ? <Pill tone="warning">Late</Pill> : null}
                    </span>
                  </td>
                  <td data-label="Manage">
                    <span className="flex flex-wrap items-center gap-2">
                    <WhoSheet
                      taskId={row.id}
                      taskName={row.name}
                      taskDates={
                        row.isMilestone
                          ? day(row.plannedStart)
                          : `${day(row.plannedStart)} – ${day(row.plannedEnd)}`
                      }
                      rows={assignmentViews(row)}
                      assigneeOptions={assigneeOptions}
                      responseOptions={responseOptions}
                      canEdit={allowed && !isVoid}
                      disabledNote={
                        isVoid
                          ? 'This task is void, so who was on it is a record rather than a plan.'
                          : allowed
                            ? undefined
                            : REFUSAL
                      }
                      assignAction={assignToTask}
                      updateAction={updateAssignment}
                      removeAction={removeAssignment}
                    />
                    <SheetButton
                      trigger="Change…"
                      label={`Change ${row.name}`}
                      title={`Change ${row.name}`}
                      subtitle={
                        predecessorName
                          ? waitsOnLabel(predecessorName, row.lagDays)
                          : 'Waits on nothing'
                      }
                      size="xl"
                      discardPrompt="Throw away the changes to this task? Nothing has been saved yet."
                    >
                      <TaskEditor
                        task={row}
                        tradeOptions={tradeOptions(row)}
                        costCodeOptions={costCodeOptions(row)}
                        predecessorOptions={predecessorOptions(row)}
                        locale={locale}
                        allowed={allowed}
                        mayVoid={mayVoid}
                        refusal={REFUSAL}
                      />
                    </SheetButton>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}

      {openTask ? (
        <TaskSheet
          closeHref={filterHref(`/projects/${project.id}/schedule`, {
            view: viewParam(view),
            period: periodParam(period),
            on: anchor === today ? '' : anchor,
          })}
          label={`Change ${openTask.name}`}
          title={openTask.name}
          subtitle={
            openTask.isMilestone
              ? day(openTask.plannedStart)
              : `${day(openTask.plannedStart)} – ${day(openTask.plannedEnd)}`
          }
          discardPrompt="Throw away the changes to this task? Nothing has been saved yet."
        >
          <TaskEditor
            task={openTask}
            tradeOptions={tradeOptions(openTask)}
            costCodeOptions={costCodeOptions(openTask)}
            predecessorOptions={predecessorOptions(openTask)}
            locale={locale}
            allowed={allowed}
            mayVoid={mayVoid}
            refusal={REFUSAL}
            above={
              <p className="t-small text-muted">
                {openOnIt.length === 0 ? 'Nobody booked' : openOnIt.join(', ')}
              </p>
            }
          />
        </TaskSheet>
      ) : null}

    </div>
  );
}
