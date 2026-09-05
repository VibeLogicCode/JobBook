import { and, asc, eq, ne } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { costCodes, organization, projects, scheduleTasks } from '@/db/schema';
import { resolveActor } from '@/app/settings/actor';
import { can } from '@/lib/auth/permissions';
import { addDays, tenantToday } from '@/lib/quote/dates';
import { latestDate } from '@/lib/schedule/calendar';
import { findPredecessorCycle, type ScheduleTask } from '@/lib/schedule/push';
import {
  createTask,
  updateTask,
  voidTask,
} from '@/app/projects/[id]/schedule/actions';
import {
  STATUS_LABELS,
  TASK_STATUSES,
  dayFormatter,
  durationLabel,
  statusTone,
  waitsOnLabel,
  type TaskStatus,
} from '@/app/projects/[id]/schedule/schema';
import { MoveDates } from '@/app/projects/[id]/schedule/MoveDates';
import { ActionForm } from '@/components/settings/ActionForm';
import {
  CheckboxField,
  FieldGrid,
  SelectField,
  TextAreaField,
  TextField,
  type Option,
} from '@/components/settings/Fields';
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

  const [org] = await db.select({ locale: organization.locale }).from(organization);
  const locale = org?.locale ?? 'en-CA';
  const day = dayFormatter(locale);
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

  /** The fields shared by adding a task and editing one. */
  function sharedFields(row: TaskRow | undefined, prefix: string, disabled: boolean) {
    return (
      <>
        <TextField
          idPrefix={prefix}
          name="name"
          label="Task"
          required
          maxLength={200}
          defaultValue={row?.name}
          disabled={disabled}
          hint="What you would call it on the phone — excavation, rough-in, drywall."
        />
        <TextField
          idPrefix={prefix}
          name="trade"
          label="Trade"
          maxLength={120}
          defaultValue={row?.trade}
          disabled={disabled}
          hint="Which trade this needs. Naming the actual subcontractor comes with assignments; this is the half that says who to go looking for."
        />
        <SelectField
          idPrefix={prefix}
          name="costCodeId"
          label="Cost code"
          defaultValue={row?.costCodeId ?? ''}
          options={costCodeOptions(row)}
          blankLabel="None — code the spend when it arrives"
          disabled={disabled}
        />
        <SelectField
          idPrefix={prefix}
          name="predecessorTaskId"
          label="Waits on"
          defaultValue={row?.predecessorTaskId ?? ''}
          options={predecessorOptions(row)}
          blankLabel="Nothing — this date stands on its own"
          disabled={disabled}
          hint="A task that waits on another moves when that one moves. A task that waits on nothing NEVER moves on its own — not because it sits between two tasks that did, and not because anything looked like it was in the way."
        />
      </>
    );
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
        description="The order the work happens in. A task can wait on one other task; when that one moves, everything waiting behind it moves with it — and you are shown what that is before anything is written."
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
                {sharedFields(undefined, 'new-task', !allowed)}
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
                  hint="Counted inclusively: the same date twice is a one-day task. Calendar days, weekends included — a crew working Saturday is ordinary here."
                />
                <CheckboxField
                  idPrefix="new-task"
                  name="isMilestone"
                  label="This is a milestone, not a span of work"
                  disabled={!allowed}
                  wide
                  hint="A permit, an inspection, a delivery — a single day rather than a stretch. The finish date is set to the start date."
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
        <TableWrap minWidth="64rem">
          <thead>
            <tr>
              <th scope="col">Task</th>
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
                      <div className="flex flex-col gap-4">
                        <div>
                          <h3 className="t-small font-semibold">Move the dates</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            Everything waiting behind this task moves with it, by the same number
                            of days. A task that waits on nothing stays where it is, even if it
                            sits in the middle. You will be shown exactly which tasks move before
                            anything is written.
                          </p>
                          {/* Deliberately NOT keyed on the row's dates. The
                              revalidation that follows a successful move would
                              change that key, remount the form, and take the
                              confirmation message with it -- so the owner would
                              press "Move them" and be told nothing. The boxes
                              are already right without it: they hold what was
                              submitted, and the sheet mounts fresh from the
                              row every time it is opened. */}
                          <MoveDates
                            taskId={row.id}
                            taskName={row.name}
                            plannedStart={row.plannedStart}
                            plannedEnd={row.plannedEnd}
                            isMilestone={row.isMilestone}
                            locale={locale}
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This task is void. Its dates are a record rather than a plan.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          />
                        </div>

                        <div>
                          <h3 className="t-small font-semibold">Everything else</h3>
                          <p className="mb-2 max-w-prose t-small text-subtle">
                            What it is called, what it waits on, and what actually happened. The
                            planned dates are not here on purpose — they move above, where the
                            consequence is shown first.
                          </p>
                          <ActionForm
                            action={updateTask}
                            submitLabel="Save this task"
                            disabled={!allowed || isVoid}
                            disabledNote={
                              isVoid
                                ? 'This task is void. A void row is kept as a record and is not edited.'
                                : allowed
                                  ? undefined
                                  : REFUSAL
                            }
                          >
                            <input type="hidden" name="id" value={row.id} />
                            <FieldGrid>
                              {sharedFields(row, `edit-${row.id}`, !allowed || isVoid)}
                              <SelectField
                                idPrefix={`edit-${row.id}`}
                                name="status"
                                label="Status"
                                defaultValue={row.status}
                                options={TASK_STATUSES.map((status) => ({
                                  value: status,
                                  label: STATUS_LABELS[status],
                                }))}
                                disabled={!allowed || isVoid}
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="actualStart"
                                label="Actually started"
                                type="date"
                                defaultValue={row.actualStart ?? ''}
                                disabled={!allowed || isVoid}
                                hint="A fact, never computed. Recording one also takes this task out of the auto-push: once work has begun, moving its plan would erase the difference between what was planned and what happened, which is the measurement that makes the next quote better."
                              />
                              <TextField
                                idPrefix={`edit-${row.id}`}
                                name="actualEnd"
                                label="Actually finished"
                                type="date"
                                defaultValue={row.actualEnd ?? ''}
                                disabled={!allowed || isVoid}
                              />
                            </FieldGrid>
                            <TextAreaField
                              idPrefix={`edit-${row.id}`}
                              name="notes"
                              label="Notes"
                              rows={2}
                              defaultValue={row.notes}
                              disabled={!allowed || isVoid}
                            />
                          </ActionForm>
                        </div>

                        {isVoid ? (
                          <div>
                            <h3 className="t-small font-semibold">Voided</h3>
                            <p className="max-w-prose t-small text-subtle">
                              {row.voidReason ?? 'No reason was recorded.'}
                            </p>
                          </div>
                        ) : (
                          <div>
                            <h3 className="t-small font-semibold">Void it</h3>
                            <p className="mb-2 max-w-prose t-small text-subtle">
                              For a task that should never have been on the schedule. It is not how
                              you record work you decided against — that is a status and a note.
                              Voiding is refused while anything still waits on this task, because a
                              task waiting on a voided row is a dependency no screen would show.
                            </p>
                            <ActionForm
                              action={voidTask}
                              submitLabel="Void this task"
                              destructive
                              disabled={!mayVoid}
                              disabledNote={
                                mayVoid ? undefined : 'Your role does not permit voiding a record.'
                              }
                            >
                              <input type="hidden" name="id" value={row.id} />
                              <TextField
                                idPrefix={`void-${row.id}`}
                                name="reason"
                                label="Reason"
                                required
                                maxLength={300}
                                disabled={!mayVoid}
                                wide
                                hint="Recorded on the row. A void with no reason teaches nobody anything a year later."
                              />
                            </ActionForm>
                          </div>
                        )}
                      </div>
                    </SheetButton>
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
