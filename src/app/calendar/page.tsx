import { and, asc, eq, gte, isNull, lte, ne } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { db } from '@/db/client';
import {
  assignments,
  costCodes,
  organization,
  projects,
  scheduleTasks,
  trades,
} from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { listOptionLabel } from '@/app/settings/vendor-lists';
import { assigneeKey } from '@/app/projects/[id]/schedule/clashes';
import { dayFormatter, type Assignee } from '@/app/projects/[id]/schedule/schema';
import { can } from '@/lib/auth/permissions';
import { normalizeSearch } from '@/lib/list/search';
import { tenantToday } from '@/lib/quote/dates';
import {
  PERIOD_LABELS,
  buildDays,
  daysOfRange,
  periodParam,
  rangeOf,
  readAnchor,
  readPeriod,
  summarize,
  type CalendarTask,
  type EntryFilter,
  type Period,
} from '@/lib/schedule/agenda';
import { findPredecessorCycle, type ScheduleTask } from '@/lib/schedule/push';
import { nameOf, readRoster } from '@/lib/schedule/roster';
import { CalendarGrid } from '@/components/schedule/CalendarGrid';
import { PeriodNav } from '@/components/schedule/PeriodNav';
import { TaskEditor } from '@/components/schedule/TaskEditor';
import { TaskSheet } from '@/components/schedule/TaskSheet';
import type { Option } from '@/components/settings/Fields';
import { Card } from '@/components/ui/Card';
import { FilterBar, NoMatches, filterHref, type FilterSelect } from '@/components/ui/FilterBar';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read this schedule but not change it.';

/**
 * The value the person filter carries for work nobody is booked against.
 *
 * Cannot collide with an assignee key, which is always `vendor:<uuid>` or
 * `user:<uuid>`. It is offered as a filter rather than left implicit because
 * `agenda.ts` is explicit that scheduled work with nobody on it is the most
 * dangerous row on the screen, and "show me only those" is the question that
 * follows the moment the count line says there are four of them.
 */
const NOBODY = 'nobody';

/**
 * The browser tab, which every screen in this product currently shares.
 *
 * The tenant's name stays in it, per the layout's rule that everything
 * user-visible comes from the organization record -- this only says which of
 * that tenant's screens is open, because the owner works with the schedule and
 * a job's own page in two tabs and neither one could be told from the other.
 */
export async function generateMetadata(): Promise<Metadata> {
  const [org] = await db.select({ displayName: organization.displayName }).from(organization);
  return {
    title: org ? `Calendar — ${org.displayName}` : 'Calendar',
    description: 'Every job’s schedule by the day, and who is booked in two places at once.',
  };
}

/** A search parameter as one value. A repeated parameter is the first one. */
function one(raw: string | string[] | undefined): string {
  return (Array.isArray(raw) ? raw[0] : raw) ?? '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Excavation, Site survey and Kitchen rough-in" — the warning's list of tasks. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * WHO IS ON SITE ON THURSDAY, across every job, and is anybody promised twice.
 *
 * The owner's words: *"we can use calendar view in high level to show calendar
 * type view with entire schedule showing who is scheduled on what day,
 * internal resource, me, vendor"*.
 *
 * `/projects/[id]/schedule` cannot answer it. A double-booking has its two
 * halves on two different jobs' screens, so the one place a collision is
 * structurally invisible is exactly where it costs money -- which is why the
 * warning at the top of this page is the reason the page exists, and why the
 * arithmetic behind it is deliberately NOT narrowed by anything the reader
 * filters.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILTERS ARE NOT IN THE `where` CLAUSE
 * ---------------------------------------------------------------------------
 *
 * Every other list screen in this product filters in SQL, and that is still
 * the house rule. This one cannot, and the reason is the whole feature.
 *
 * Filter this calendar to one job and the clash on it would DISAPPEAR -- not
 * because it stopped happening, but because the framer's other task is on the
 * job that just got filtered out. So the read is of every live job in the
 * period, `buildDays` counts the collisions across all of it, and the reader's
 * filter is a predicate that marks lines invisible afterwards. See `EntryFilter`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSIGNMENT JOIN IS A LEFT JOIN
 * ---------------------------------------------------------------------------
 *
 * A task with nobody booked against it has to come back. It is scheduled work
 * that gets discovered on the morning, and an inner join would drop precisely
 * the row the owner most needs from this screen. The join's OWN conditions --
 * not removed, not voided -- stay in the `on` clause rather than moving to the
 * `where`, because in the `where` they would filter the task away again the
 * moment its only assignment was a removed one.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const q = normalizeSearch(one(query.q));
  const job = one(query.job);
  const who = one(query.who);
  const period = readPeriod(one(query.period) || undefined);
  const openTaskId = one(query.task);

  const [org] = await db
    .select({ locale: organization.locale, displayName: organization.displayName })
    .from(organization);
  const locale = org?.locale ?? 'en-CA';
  const day = dayFormatter(locale);

  // The tenant's own date, from the database. `new Date()` in a UTC container
  // reads as tomorrow from early evening, so a calendar built on it would mark
  // the wrong cell Today and anchor the default week on the wrong seven days.
  const today = await db.transaction((tx) => tenantToday(tx));
  const anchor = readAnchor(one(query.on) || undefined, today);
  const range = rangeOf(period, anchor);

  const state = await resolveActor();

  const rows = await db
    .select({
      taskId: scheduleTasks.id,
      taskName: scheduleTasks.name,
      plannedStart: scheduleTasks.plannedStart,
      plannedEnd: scheduleTasks.plannedEnd,
      isMilestone: scheduleTasks.isMilestone,
      // The name, not the id -- `CalendarTask.trade` is a display string, and a
      // retired trade still has to resolve here: retiring is a statement about
      // new work, not about the task that already named it.
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
        // A voided task is off the schedule, and a voided job's schedule is a
        // record rather than a plan. Neither can double-book anybody.
        ne(scheduleTasks.recordStatus, 'void'),
        ne(projects.recordStatus, 'void'),
        // Both ends inclusive, matching `plannedStart`/`plannedEnd` and
        // `spansOverlap`: a one-day milestone still overlaps the week it sits in.
        lte(scheduleTasks.plannedStart, range.end),
        gte(scheduleTasks.plannedEnd, range.start),
      ),
    )
    .orderBy(asc(scheduleTasks.plannedStart), asc(projects.projectNumber), asc(scheduleTasks.name));

  /**
   * What to call each person, through the ONE helper that knows a vendor from a
   * user. Nothing downstream of this branches on the kind of assignee, which is
   * what makes the arriving `crew` table one select in `readRoster` rather than
   * a sweep of this screen.
   */
  const roster = await readRoster(db, state.actor?.id ?? null);

  /** One task per row, with the people on it folded in. */
  const byTask = new Map<string, CalendarTask>();
  for (const row of rows) {
    let task = byTask.get(row.taskId);
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
      byTask.set(row.taskId, task);
    }
    // The left join produces one all-null pair for a task nobody is on. Exactly
    // one of the two columns is set on a real row -- the database holds that.
    const assignee: Assignee | null =
      row.vendorId !== null
        ? { kind: 'vendor', id: row.vendorId }
        : row.userId !== null
          ? { kind: 'user', id: row.userId }
          : null;
    if (assignee) task.assignees.push({ assignee, name: nameOf(roster, assignee) });
  }
  const tasks = [...byTask.values()];

  /* -----------------------------------------------------------------------
     What the reader may narrow to
     ----------------------------------------------------------------------- */

  /**
   * Every job with a schedule, and every person who holds a live assignment on
   * one -- across ALL time, not just the period on screen.
   *
   * Options built from the current period would vanish when the reader stepped
   * to the next one, and a select whose `defaultValue` matches no option
   * silently shows the first instead: the URL would go on filtering while the
   * control said "Any job". Same trap the schedule screen's cost-code picker
   * documents.
   */
  const [jobRows, assigneeRows] = await Promise.all([
    db
      .selectDistinct({
        id: projects.id,
        projectNumber: projects.projectNumber,
        name: projects.name,
      })
      .from(projects)
      .innerJoin(scheduleTasks, eq(scheduleTasks.projectId, projects.id))
      .where(and(ne(projects.recordStatus, 'void'), ne(scheduleTasks.recordStatus, 'void')))
      .orderBy(asc(projects.projectNumber)),
    db
      .selectDistinct({ vendorId: assignments.vendorId, userId: assignments.userId })
      .from(assignments)
      .innerJoin(scheduleTasks, eq(scheduleTasks.id, assignments.scheduleTaskId))
      .innerJoin(projects, eq(projects.id, scheduleTasks.projectId))
      .where(
        and(
          isNull(assignments.removedAt),
          ne(assignments.recordStatus, 'void'),
          ne(scheduleTasks.recordStatus, 'void'),
          ne(projects.recordStatus, 'void'),
        ),
      ),
  ]);

  const jobOptions = jobRows.map((row) => ({
    value: row.id,
    label: `${row.projectNumber} — ${row.name}`,
  }));

  const peopleOptions = assigneeRows
    .map((row) => {
      const assignee: Assignee =
        row.vendorId !== null
          ? { kind: 'vendor', id: row.vendorId }
          : { kind: 'user', id: row.userId! };
      return { value: assigneeKey(assignee), label: nameOf(roster, assignee) };
    })
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  /**
   * The reader's filter, as a predicate rather than as SQL. See the note on
   * this page's default export, and on `EntryFilter`: what a filter changes is
   * which lines are drawn, never whether the collision happened.
   */
  const words = q.toLowerCase().split(' ').filter(Boolean);
  const keep: EntryFilter = (entry) => {
    if (job !== '' && entry.projectId !== job) return false;
    if (who === NOBODY) {
      if (entry.assigneeKey !== null) return false;
    } else if (who !== '' && entry.assigneeKey !== who) return false;
    if (words.length > 0) {
      const haystack =
        `${entry.taskName} ${entry.projectNumber} ${entry.projectName} ${entry.who ?? ''}`.toLowerCase();
      if (!words.every((word) => haystack.includes(word))) return false;
    }
    return true;
  };

  const days = buildDays(daysOfRange(range), tasks, keep);
  const summary = summarize(days);

  /* -----------------------------------------------------------------------
     Where in the calendar we are, entirely in the URL
     ----------------------------------------------------------------------- */

  /**
   * A link to this screen at another period or another anchor, filters kept.
   *
   * The anchor is dropped when it is today's date, the same way `periodParam`
   * drops the default week: `/calendar` stays the plain address every link into
   * this screen uses, and only a deliberate choice shows up in the URL.
   */
  const linkTo = (nextPeriod: Period, nextAnchor: string) =>
    filterHref('/calendar', {
      q,
      job,
      who,
      period: periodParam(nextPeriod),
      on: nextAnchor === today ? '' : nextAnchor,
    });

  const closeHref = linkTo(period, anchor);

  const filtered = q !== '' || job !== '' || who !== '';
  const describe = [
    job ? `Job: ${jobOptions.find((option) => option.value === job)?.label ?? job}` : '',
    who === NOBODY
      ? 'Person: nobody booked'
      : who
        ? `Person: ${peopleOptions.find((option) => option.value === who)?.label ?? who}`
        : '',
  ].filter(Boolean);

  const selects: FilterSelect[] = [
    { name: 'job', label: 'Job', value: job, anyLabel: 'Any job', options: jobOptions },
    {
      name: 'who',
      label: 'Person',
      value: who,
      anyLabel: 'Anybody',
      options: [{ value: NOBODY, label: 'Nobody booked' }, ...peopleOptions],
    },
  ];

  /* -----------------------------------------------------------------------
     The one task the URL has open
     ----------------------------------------------------------------------- */

  const open = UUID.test(openTaskId) ? await loadOpenTask(openTaskId, locale, roster) : null;
  const openJobIsVoid = open?.project.recordStatus === 'void';
  const allowed = state.actor ? can(state.actor.role, 'quote:write') && !openJobIsVoid : false;
  const mayVoid = state.actor ? can(state.actor.role, 'record:void') && !openJobIsVoid : false;

  return (
    <div className="px-4 py-4 sm:px-6">
      <PageHeader
        className="mb-4"
        title="Calendar"
        description="Every job's schedule, by the day. A person booked in two places on the same day is called out here, because the two halves of it live on two different job screens."
      />

      {state.actor ? null : (
        <div className="mb-3">
          <Notice tone="warning">{state.reason}</Notice>
        </div>
      )}

      {/* The reason this screen exists, so it is above the grid rather than a
          tone inside it. It survives every filter: `summarize` counts clashes
          from hidden lines too. */}
      {summary.worst ? (
        <Notice
          tone="warning"
          role="status"
          className="mb-3"
          title={`${summary.clashes} double-booking${summary.clashes === 1 ? '' : 's'}`}
        >
          <p>
            {summary.worst.who} is on {andList(summary.worst.taskNames)} on{' '}
            {day(summary.worst.date)}.
          </p>
          {summary.firstClashDay && period !== 'day' ? (
            // The day view of the trouble, not `on=` at the current period:
            // the clash day is already inside the range on screen, so keeping
            // the period would be a link that goes nowhere.
            <p className="mt-1">
              <Link href={linkTo('day', summary.firstClashDay)} className="underline">
                Open {day(summary.firstClashDay)}
              </Link>
            </p>
          ) : null}
        </Notice>
      ) : null}

      <FilterBar
        basePath="/calendar"
        q={q}
        searchLabel="Task, job or person"
        searchPlaceholder="excavation, P-2026-0001"
        selects={selects}
        // Without these, pressing Search would drop the period and the anchor
        // and land the reader back on this week. A GET form posts its own
        // controls and nothing else.
        carry={{ period: periodParam(period), on: anchor === today ? '' : anchor }}
        shown={summary.shown}
        noun={{ singular: 'day of work', plural: 'days of work' }}
      />

      <PeriodNav
        basePath="/calendar"
        carry={{ q, job, who }}
        period={period}
        anchor={anchor}
        today={today}
        locale={locale}
        extra={
          summary.unassigned > 0 ? (
            <span className="t-small text-muted">{summary.unassigned} with nobody booked</span>
          ) : null
        }
      />

      {/* Said above the grid rather than instead of it. Below `sm` every cell
          is hidden by then, so this line is what remains; at a monitor the
          empty week is still drawn, because an empty week is a fact. */}
      {summary.shown === 0 ? (
        filtered ? (
          <div className="mb-3">
            <NoMatches
              basePath={filterHref('/calendar', {
                period: periodParam(period),
                on: anchor === today ? '' : anchor,
              })}
              q={q}
              describe={describe}
              noun="scheduled work"
            />
          </div>
        ) : (
          <Card as="div" className="mb-3 p-6 text-muted">
            Nothing is scheduled in this {PERIOD_LABELS[period].toLowerCase()}.
          </Card>
        )
      ) : null}

      <CalendarGrid
        days={days}
        columns={period === 'day' ? 1 : 7}
        locale={locale}
        today={today}
        taskHref={(taskId) =>
          filterHref('/calendar', {
            q,
            job,
            who,
            period: periodParam(period),
            on: anchor === today ? '' : anchor,
            task: taskId,
          })
        }
      />

      {open ? (
        <TaskSheet
          closeHref={closeHref}
          label={`Change ${open.task.name}`}
          title={open.task.name}
          subtitle={
            open.task.isMilestone
              ? day(open.task.plannedStart)
              : `${day(open.task.plannedStart)} – ${day(open.task.plannedEnd)}`
          }
          discardPrompt="Throw away the changes to this task? Nothing has been saved yet."
        >
          <TaskEditor
            task={open.task}
            tradeOptions={open.tradeOptions}
            costCodeOptions={open.costCodeOptions}
            predecessorOptions={open.predecessorOptions}
            locale={locale}
            allowed={allowed}
            mayVoid={mayVoid}
            refusal={state.actor ? REFUSAL : (state.reason ?? REFUSAL)}
            // A block tapped on a calendar carries no row above it to say which
            // job it came from or who is standing on it, which is the whole
            // reason `above` exists.
            above={
              <div className="grid gap-1">
                <p className="t-small">
                  <Link href={`/projects/${open.project.id}/schedule`} className="underline">
                    {open.project.projectNumber}
                  </Link>
                  <span className="text-muted"> · {open.project.name}</span>
                </p>
                <p className="t-small text-muted">
                  {open.onIt.length === 0 ? 'Nobody booked' : open.onIt.join(', ')}
                </p>
              </div>
            }
          />
        </TaskSheet>
      ) : null}
    </div>
  );
}

/**
 * The task the URL names, with the options its editor needs.
 *
 * Read by id and NOT out of the rows above, deliberately. A link can name a
 * task outside the period on screen -- a bookmark, a message to himself, the
 * period stepped after the sheet was opened -- and a sheet that silently failed
 * to appear would read as a broken link. A voided task loads too: `TaskEditor`
 * renders one as a record, which is more honest than nothing.
 */
async function loadOpenTask(
  taskId: string,
  locale: string,
  roster: Awaited<ReturnType<typeof readRoster>>,
): Promise<{
  task: typeof scheduleTasks.$inferSelect;
  project: { id: string; projectNumber: string; name: string; recordStatus: string };
  tradeOptions: Option[];
  costCodeOptions: Option[];
  predecessorOptions: Option[];
  onIt: string[];
} | null> {
  const [task] = await db.select().from(scheduleTasks).where(eq(scheduleTasks.id, taskId));
  if (!task) return null;

  const [[project], siblings, allCodes, allTrades, onItRows] = await Promise.all([
    db
      .select({
        id: projects.id,
        projectNumber: projects.projectNumber,
        name: projects.name,
        recordStatus: projects.recordStatus,
      })
      .from(projects)
      .where(eq(projects.id, task.projectId)),
    db
      .select()
      .from(scheduleTasks)
      .where(
        and(eq(scheduleTasks.projectId, task.projectId), ne(scheduleTasks.recordStatus, 'void')),
      )
      .orderBy(asc(scheduleTasks.plannedStart), asc(scheduleTasks.sortOrder)),
    db
      .select({
        id: costCodes.id,
        code: costCodes.code,
        name: costCodes.name,
        isActive: costCodes.isActive,
      })
      .from(costCodes)
      .where(ne(costCodes.recordStatus, 'void'))
      .orderBy(asc(costCodes.code)),
    db.select().from(trades).orderBy(asc(trades.sortOrder), asc(trades.name)),
    db
      .select({ vendorId: assignments.vendorId, userId: assignments.userId })
      .from(assignments)
      .where(
        and(
          eq(assignments.scheduleTaskId, taskId),
          isNull(assignments.removedAt),
          ne(assignments.recordStatus, 'void'),
        ),
      )
      .orderBy(asc(assignments.createdAt)),
  ]);

  if (!project) return null;

  // Active trades, plus this task's own if retiring left it off the list --
  // the same rule `costCodeOptions` below draws for the same reason.
  const tradeOptions: Option[] = allTrades
    .filter((trade) => trade.isActive && trade.recordStatus === 'active')
    .map((trade) => ({ value: trade.id, label: trade.name }));
  const currentTrade = task.tradeId ? allTrades.find((trade) => trade.id === task.tradeId) : undefined;
  if (currentTrade && !tradeOptions.some((option) => option.value === currentTrade.id)) {
    tradeOptions.push({ value: currentTrade.id, label: listOptionLabel(currentTrade) });
  }

  // The predecessor picker prints dates, so it reads in the tenant's own locale
  // rather than in the one this helper happened to be written in.
  const day = dayFormatter(locale);
  const codeIds = new Set(allCodes.map((code) => code.id));
  const costCodeOptions: Option[] = allCodes.map((code) => ({
    value: code.id,
    label: `${code.code} — ${code.name}${code.isActive ? '' : ' (retired)'}`,
  }));
  // A select whose defaultValue matches no option silently shows the first one
  // instead, and the next save would recode the task to whatever sorted first.
  if (task.costCodeId && !codeIds.has(task.costCodeId)) {
    costCodeOptions.push({
      value: task.costCodeId,
      label: 'The code this was set to (now void)',
    });
  }

  /**
   * What this task may be told to wait on: everything live on its own job
   * except itself and except anything that already reaches it through the
   * chain. `findPredecessorCycle` is the same function the action runs inside
   * its transaction, so the picker cannot offer something the save would refuse.
   */
  const graph: ScheduleTask[] = siblings.map((row) => ({
    id: row.id,
    name: row.name,
    plannedStart: row.plannedStart,
    plannedEnd: row.plannedEnd,
    actualStart: row.actualStart,
    actualEnd: row.actualEnd,
    predecessorTaskId: row.predecessorTaskId,
    lagDays: row.lagDays,
  }));
  const predecessorOptions: Option[] = graph
    .filter(
      (candidate) =>
        candidate.id !== task.id && findPredecessorCycle(graph, task.id, candidate.id) === null,
    )
    .map((candidate) => ({
      value: candidate.id,
      label: `${candidate.name} — ends ${day(candidate.plannedEnd)}`,
    }));

  const onIt = onItRows.map((row) =>
    nameOf(
      roster,
      row.vendorId !== null
        ? { kind: 'vendor', id: row.vendorId }
        : { kind: 'user', id: row.userId! },
    ),
  );

  return { task, project, tradeOptions, costCodeOptions, predecessorOptions, onIt };
}
