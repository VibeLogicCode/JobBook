import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import {
  assignments,
  costCodes,
  organization,
  projects,
  scheduleTasks,
  users,
  vendors,
} from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import { formatCents } from '@/lib/money/format';
import { addDays, tenantToday } from '@/lib/quote/dates';
import { latestDate } from '@/lib/schedule/calendar';
import { findPredecessorCycle, type ScheduleTask } from '@/lib/schedule/push';
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
import { TaskEditor, TaskFields } from '@/components/schedule/TaskEditor';
import { Card } from '@/components/ui/Card';
import { MetricCard } from '@/components/ui/MetricCard';
import { Notice } from '@/components/ui/Notice';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pill } from '@/components/ui/Pill';
import { SheetButton } from '@/components/ui/Sheet';
import { TableWrap } from '@/components/ui/Table';

export const dynamic = 'force-dynamic';

const REFUSAL = 'Your role can read this schedule but not change it.';

type TaskRow = typeof scheduleTasks.$inferSelect;

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
  const showVoided = (Array.isArray(query.voided) ? query.voided[0] : query.voided) === '1';

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

      {rows.length === 0 ? (
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
                      {[row.trade, code ? `${code.code} — ${code.name}` : null]
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

      {voided.length > 0 ? (
        <p className="mt-3 t-small text-subtle">
          {/* A count, not a silence. A list that quietly drops rows is a list
              the owner reads as having lost them. */}
          <Link href={`/projects/${project.id}/schedule${showVoided ? '' : '?voided=1'}`} className="underline">
            {showVoided
              ? `Hide the ${voided.length} voided ${voided.length === 1 ? 'task' : 'tasks'}`
              : `Show ${voided.length} voided ${voided.length === 1 ? 'task' : 'tasks'}`}
          </Link>
          {' · '}
          {shownCount} {shownCount === 1 ? 'task' : 'tasks'} on screen
        </p>
      ) : null}
    </div>
  );
}
