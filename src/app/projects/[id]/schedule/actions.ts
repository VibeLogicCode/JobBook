'use server';

import { createHash } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { costCodes, organization, projects, scheduleTasks } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { lagBetween } from '@/lib/schedule/calendar';
import {
  canonicalScheduleText,
  describeMove,
  findPredecessorCycle,
  planMove,
  type ScheduleTask,
} from '@/lib/schedule/push';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  TASK_LABELS,
  dayFormatter,
  editTaskFields,
  hasSqlState,
  heldRows,
  moveFields,
  newTaskFields,
  previewRows,
  voidTaskFields,
  type MoveState,
} from '@/app/projects/[id]/schedule/schema';

/**
 * The schedule's write side.
 *
 * Four rules run through every action in this file.
 *
 * 1. **Authorization is a separate per-request lookup, before any argument is
 *    read.** `guard('quote:write')` reads the role out of `users` every time.
 *    `quote:write` is the capability rather than `rates:edit`, and the choice
 *    is deliberate: the vendor list and the cost code list took `rates:edit`
 *    because they are reference lists that priced records point at, maintained
 *    by whoever runs the work. A schedule is not a reference list -- it is a
 *    record about ONE JOB, edited daily by whoever is running that job, and
 *    the matrix already draws exactly the line this needs. An `owner` and an
 *    `admin` may change it; a `bookkeeper` may read the whole screen and
 *    change none of it, which is right for a role that prepares the year end
 *    and must never be able to restate when work was planned. Voiding takes
 *    `record:void`, as it does everywhere else in the product, and a
 *    `bookkeeper` holds neither.
 *
 * 2. **Nothing is deleted.** `record_status = 'void'` with a reason. The
 *    database role holds no DELETE privilege at all.
 *
 * 3. **`updated_at` is never written here.** A trigger maintains it, and a
 *    value written by hand would be the one the SharePoint sync cursor trusts.
 *
 * 4. **Every check that decides whether a write is legal runs INSIDE the
 *    transaction that writes.** The screen was rendered seconds or hours ago.
 *    A predecessor that existed then may be void now, and -- the case that
 *    matters -- a second tab may have added the other half of a loop between
 *    this request's read and its write. See `lockProject`.
 */

/* -------------------------------------------------------------------------
   The lock, and the reads every action shares
   ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Serialises every dependency-changing write on one job.
 *
 * A cycle check is a read followed by a write, and under read committed the
 * two transactions that would create A→B and B→A cannot see each other's
 * uncommitted rows. Both would read a chain that looked fine and both would
 * commit, and the push would then walk forever. An advisory lock keyed on the
 * project closes that window: the second transaction waits, then reads a chain
 * that includes the first one's row.
 *
 * A single lock rather than `SELECT ... FOR UPDATE` over the rows, so it cannot
 * deadlock against the row locks an UPDATE statement takes on its own. It is
 * held to the end of the transaction and released by the commit, and it costs
 * nothing: a job has tens of tasks and one person editing them.
 *
 * The trigger installed by migration 0012 takes the SAME lock, so the guarantee
 * holds even for a write that never came through this file.
 */
async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${projectId}::text, 0))`);
}

/** Every live task on a job, in the shape the push reads. */
async function readTasks(tx: Tx, projectId: string): Promise<ScheduleTask[]> {
  return tx
    .select({
      id: scheduleTasks.id,
      name: scheduleTasks.name,
      plannedStart: scheduleTasks.plannedStart,
      plannedEnd: scheduleTasks.plannedEnd,
      actualStart: scheduleTasks.actualStart,
      actualEnd: scheduleTasks.actualEnd,
      predecessorTaskId: scheduleTasks.predecessorTaskId,
      lagDays: scheduleTasks.lagDays,
    })
    .from(scheduleTasks)
    .where(
      and(
        eq(scheduleTasks.projectId, projectId),
        // A void task is not on the schedule, so it is neither pushed nor
        // counted in the job's finish date.
        ne(scheduleTasks.recordStatus, 'void'),
      ),
    )
    .orderBy(asc(scheduleTasks.plannedStart), asc(scheduleTasks.sortOrder));
}

/**
 * The fingerprint the preview is stamped with.
 *
 * `canonicalScheduleText` is the pure half and is where the reasoning lives;
 * this is only the hash. Truncated to 32 hex characters because it travels in
 * a hidden form field and is a change detector, not a signature: forging one
 * requires knowing the schedule's current state, in which case the preview the
 * owner read was already correct.
 */
function fingerprintOf(tasks: readonly ScheduleTask[]): string {
  return createHash('sha256').update(canonicalScheduleText(tasks)).digest('hex').slice(0, 32);
}

/**
 * "This job should never have existed", which is a different statement from
 * anything about the schedule on it.
 *
 * Checked in every action rather than only when a task is added, because the
 * screen renders a voided job read-only and a screen is not where a refusal
 * lives. A voided project's tasks stay readable -- they are the record of what
 * was planned -- and stop being editable.
 */
async function projectIsVoid(tx: Tx, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ recordStatus: projects.recordStatus })
    .from(projects)
    .where(eq(projects.id, projectId));
  return !row || row.recordStatus === 'void';
}

async function tenantLocale(tx: Tx): Promise<string> {
  const [row] = await tx.select({ locale: organization.locale }).from(organization);
  return row?.locale ?? 'en-CA';
}

/**
 * Deliberately NOT `error.message`.
 *
 * Every write here runs in a transaction, and Drizzle wraps a driver error in
 * a `DrizzleQueryError` whose message is the failed SQL and its bound
 * parameters. Putting that on screen tells the owner nothing he can act on and
 * shows him the schema; the server log still has the whole thing.
 */
function failureText(error: unknown): string {
  if (hasSqlState(error, '23514')) {
    return 'That change breaks one of the rules a task has to keep — a milestone is a single day, a finish cannot come before its own start, and no task may wait on itself. Nothing was written.';
  }
  if (hasSqlState(error, '23503')) {
    return 'Something this task points at is no longer there. Reload the schedule and try again. Nothing was written.';
  }
  return 'That change could not be saved. Nothing was written.';
}

const REFUSAL = 'Your role can read this schedule but not change it.';

function refusedResult(error: string): ActionResult {
  return refused(error === 'Your role does not permit that.' ? REFUSAL : error);
}

/**
 * Whether a predecessor may be pointed at, said in a sentence.
 *
 * Read inside the writing transaction, never off the form: the list on screen
 * was built before the task that has since been voided was voided.
 */
function predecessorProblem(
  candidate: { id: string; projectId: string; recordStatus: string } | undefined,
  projectId: string,
): string | null {
  if (!candidate) return 'The task you chose to wait on is not on this schedule.';
  if (candidate.projectId !== projectId) {
    return 'A task can only wait on another task on the same job. A dependency across jobs would be invisible on the screen showing the delay it caused.';
  }
  if (candidate.recordStatus === 'void') {
    return 'The task you chose to wait on has been voided, so nothing can be scheduled behind it.';
  }
  return null;
}

/* -------------------------------------------------------------------------
   Adding a task
   ------------------------------------------------------------------------- */

export async function createTask(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('quote:write');
  if (!allowed.ok) return refusedResult(allowed.error);

  const projectId = String(formData.get('projectId') ?? '');
  const parsed = newTaskFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TASK_LABELS);
  const input = parsed.data;

  let problem: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const [project] = await tx
        .select({ id: projects.id, recordStatus: projects.recordStatus })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project || project.recordStatus === 'void') {
        problem = 'That job no longer exists.';
        return;
      }

      await lockProject(tx, projectId);

      // Derived, never typed. The dates are what the owner edits, and a lag
      // that disagrees with them is a lag nobody can trust.
      let lagDays = 0;
      if (input.predecessorTaskId !== null) {
        const [candidate] = await tx
          .select({
            id: scheduleTasks.id,
            projectId: scheduleTasks.projectId,
            recordStatus: scheduleTasks.recordStatus,
            plannedEnd: scheduleTasks.plannedEnd,
          })
          .from(scheduleTasks)
          .where(eq(scheduleTasks.id, input.predecessorTaskId));

        problem = predecessorProblem(candidate, projectId);
        if (problem) return;
        lagDays = lagBetween(candidate!.plannedEnd, input.plannedStart);
      }

      if (input.costCodeId !== null) {
        const [code] = await tx
          .select({ id: costCodes.id, code: costCodes.code, recordStatus: costCodes.recordStatus })
          .from(costCodes)
          .where(eq(costCodes.id, input.costCodeId));
        if (!code) {
          problem = 'The cost code you chose is not on the list.';
          return;
        }
        if (code.recordStatus === 'void') {
          problem = `${code.code} is void, so new work should not be coded to it.`;
          return;
        }
      }

      await tx.insert(scheduleTasks).values({
        projectId,
        name: input.name,
        trade: input.trade,
        costCodeId: input.costCodeId,
        plannedStart: input.plannedStart,
        plannedEnd: input.plannedEnd,
        isMilestone: input.isMilestone,
        predecessorTaskId: input.predecessorTaskId,
        lagDays,
        notes: input.notes,
        createdBy: allowed.actor.id,
      });
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidatePath(`/projects/${projectId}/schedule`);
  return saved(
    input.predecessorTaskId === null
      ? `${input.name} added. It waits on nothing, so its dates never move because something else moved.`
      : `${input.name} added, waiting on the task you chose. When that one moves, this one moves with it — and you will be shown what else goes with it before anything is written.`,
  );
}

/* -------------------------------------------------------------------------
   Editing everything except the planned dates
   ------------------------------------------------------------------------- */

/**
 * Name, trade, code, status, what it waits on, and the dates it ACTUALLY
 * started and finished.
 *
 * The actual pair is edited freely and computed by nothing. That is spec 5.2's
 * rule and the reason the planned pair sits beside it: overwriting a planned
 * date with an actual one destroys the only evidence of how the estimates
 * perform, which is the data that makes the next quote better.
 *
 * Recording an actual start has a second consequence worth knowing about
 * before you type it: a task that has begun is held out of the auto-push, and
 * the chain behind it stops there. The screen says so beside the field.
 */
export async function updateTask(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('quote:write');
  if (!allowed.ok) return refusedResult(allowed.error);

  const parsed = editTaskFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TASK_LABELS);
  const input = parsed.data;

  let problem: string | null = null;
  let projectId = '';
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          projectId: scheduleTasks.projectId,
          plannedStart: scheduleTasks.plannedStart,
          recordStatus: scheduleTasks.recordStatus,
        })
        .from(scheduleTasks)
        .where(eq(scheduleTasks.id, input.id));

      if (!row) {
        problem = 'That task no longer exists.';
        return;
      }
      if (row.recordStatus === 'void') {
        problem = 'That task is void. A void row is kept as a record and is not edited.';
        return;
      }
      projectId = row.projectId;

      if (await projectIsVoid(tx, projectId)) {
        problem = 'That job is void, so its schedule is a record rather than a plan.';
        return;
      }

      await lockProject(tx, projectId);

      let lagDays = 0;
      if (input.predecessorTaskId !== null) {
        const [candidate] = await tx
          .select({
            id: scheduleTasks.id,
            projectId: scheduleTasks.projectId,
            recordStatus: scheduleTasks.recordStatus,
            plannedEnd: scheduleTasks.plannedEnd,
          })
          .from(scheduleTasks)
          .where(eq(scheduleTasks.id, input.predecessorTaskId));

        problem = predecessorProblem(candidate, projectId);
        if (problem) return;

        // The cycle check, inside the transaction and under the lock. A stale
        // tab can create the other half of a loop between the moment this form
        // was rendered and the moment it was submitted, and a check that ran at
        // render time would have been true then and wrong now.
        const tasks = await readTasks(tx, projectId);
        const cycle = findPredecessorCycle(tasks, input.id, input.predecessorTaskId);
        if (cycle) {
          problem =
            cycle.length === 1
              ? `${input.name} cannot wait on itself.`
              : `That would make these tasks wait on each other in a loop — ${cycle.join(' → ')} — and a loop has no order to work in. Break one of those links first.`;
          return;
        }

        lagDays = lagBetween(candidate!.plannedEnd, row.plannedStart);
      }

      if (input.costCodeId !== null) {
        const [code] = await tx
          .select({ id: costCodes.id, code: costCodes.code, recordStatus: costCodes.recordStatus })
          .from(costCodes)
          .where(eq(costCodes.id, input.costCodeId));
        if (!code) {
          problem = 'The cost code you chose is not on the list.';
          return;
        }
        if (code.recordStatus === 'void') {
          problem = `${code.code} is void, so new work should not be coded to it.`;
          return;
        }
      }

      await tx
        .update(scheduleTasks)
        // No `updatedAt`: the trigger owns it. No planned dates: those move
        // through `moveTaskDates`, which shows what else goes with them first.
        .set({
          name: input.name,
          trade: input.trade,
          costCodeId: input.costCodeId,
          predecessorTaskId: input.predecessorTaskId,
          lagDays,
          status: input.status,
          actualStart: input.actualStart,
          actualEnd: input.actualEnd,
          notes: input.notes,
        })
        .where(eq(scheduleTasks.id, input.id));
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidatePath(`/projects/${projectId}/schedule`);
  return saved(
    input.actualStart === null
      ? `${input.name} saved.`
      : `${input.name} saved. It has a start recorded against it now, so the auto-push will leave its planned dates alone — the gap between what was planned and what happened is the measurement, and moving the plan would erase it.`,
  );
}

/* -------------------------------------------------------------------------
   The move, and the confirmation in front of it
   ------------------------------------------------------------------------- */

/**
 * Moves a task's planned dates -- in two presses.
 *
 * The first press carries no fingerprint and is a question: it computes the
 * consequence and hands back a sentence and a row per task that would move.
 * The second press carries the fingerprint of the schedule the preview was
 * computed from, and only then is anything written.
 *
 * **Why the fingerprint.** The plan calls this the single most important
 * interaction in the feature -- *a drag that silently shifts nine tasks is how
 * somebody loses a schedule they spent an evening building* -- and a preview
 * that disagrees with the commit is worse than no preview at all, because the
 * owner has stopped checking by then. Between the preview and the press,
 * another tab can add a dependency, record an actual start, or move a date, and
 * the second computation would then name a different set of tasks than the
 * sentence he agreed to.
 *
 * So the commit recomputes the whole preview from a fresh read INSIDE the
 * writing transaction and writes that -- which makes the write, by
 * construction, the output of the same pure function -- and compares the
 * fingerprint. Equal means the recomputation is the preview he read. Not equal
 * means the schedule moved underneath him, and he is shown the new consequence
 * instead of having the old one applied.
 */
export async function moveTaskDates(
  _previous: MoveState | null,
  formData: FormData,
): Promise<MoveState> {
  const allowed = await guard('quote:write');
  if (!allowed.ok) {
    return {
      status: 'refused',
      error: allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error,
    };
  }

  const parsed = moveFields.safeParse(formValues(formData));
  if (!parsed.success) {
    const result = invalid(parsed.error, TASK_LABELS);
    return result.ok
      ? { status: 'refused', error: 'That request did not make sense.' }
      : { status: 'refused', error: result.error, fieldErrors: result.fieldErrors };
  }
  const input = parsed.data;

  let outcome: MoveState;
  let projectId = '';
  try {
    outcome = await db.transaction(async (tx): Promise<MoveState> => {
      const [row] = await tx
        .select({
          projectId: scheduleTasks.projectId,
          name: scheduleTasks.name,
          isMilestone: scheduleTasks.isMilestone,
          recordStatus: scheduleTasks.recordStatus,
        })
        .from(scheduleTasks)
        .where(eq(scheduleTasks.id, input.id));

      if (!row) return { status: 'refused', error: 'That task no longer exists.' };
      if (row.recordStatus === 'void') {
        return { status: 'refused', error: 'That task is void, so its dates are a record rather than a plan.' };
      }
      projectId = row.projectId;

      if (await projectIsVoid(tx, projectId)) {
        return {
          status: 'refused',
          error: 'That job is void, so its schedule is a record rather than a plan.',
        };
      }

      await lockProject(tx, projectId);

      if (row.isMilestone && input.plannedEnd !== input.plannedStart) {
        return {
          status: 'refused',
          error: `${row.name} is a milestone, which is a single day. Give it the same date twice, or add it again as a task with a span.`,
        };
      }

      const tasks = await readTasks(tx, projectId);
      const preview = planMove(tasks, {
        taskId: input.id,
        plannedStart: input.plannedStart,
        plannedEnd: input.plannedEnd,
      });
      const day = dayFormatter(await tenantLocale(tx));

      if (preview.cycle) {
        // Refused rather than previewed: there is nothing to confirm, because
        // there is no order to work in until a link is removed.
        return { status: 'refused', error: describeMove(preview, day) };
      }

      const fingerprint = fingerprintOf(tasks);
      const asPreview = (stale: boolean): MoveState => ({
        status: 'preview',
        sentence: describeMove(preview, day),
        rows: previewRows(preview.moves),
        held: heldRows(preview.held),
        fingerprint,
        plannedStart: input.plannedStart,
        plannedEnd: input.plannedEnd,
        stale,
      });

      // First press: the question. So is a second press whose dates are no
      // longer the ones the preview described -- somebody edited a date after
      // reading it, and the answer on screen is about a different move.
      const confirming =
        input.fingerprint !== '' &&
        input.previewedStart === input.plannedStart &&
        input.previewedEnd === input.plannedEnd;
      if (!confirming) return asPreview(false);
      // Confirmed, but the schedule itself changed underneath the preview:
      // show the new consequence rather than applying the old one.
      if (input.fingerprint !== fingerprint) return asPreview(true);

      if (preview.moves.length === 0 && preview.held.length === 0) {
        return { status: 'saved', message: 'Those are the dates it already has, so nothing moved.', movedIds: [] };
      }

      for (const move of preview.moves) {
        await tx
          .update(scheduleTasks)
          .set({ plannedStart: move.toStart, plannedEnd: move.toEnd, lagDays: move.lagDays })
          .where(eq(scheduleTasks.id, move.id));
      }
      // A held task did not move, but the thing it waits on did, so the gap
      // stored on its row is no longer the gap its dates show. Restating it is
      // what keeps `lag_days` a reading of the dates rather than a second
      // opinion about them.
      for (const held of preview.held) {
        await tx
          .update(scheduleTasks)
          .set({ lagDays: held.lagDays })
          .where(eq(scheduleTasks.id, held.id));
      }

      return {
        status: 'saved',
        message: describeMove(preview, day),
        movedIds: preview.moves.map((move) => move.id),
      };
    });
  } catch (error) {
    return { status: 'refused', error: failureText(error) };
  }

  if (outcome.status === 'saved' && projectId) revalidatePath(`/projects/${projectId}/schedule`);
  return outcome;
}

/* -------------------------------------------------------------------------
   Voiding
   ------------------------------------------------------------------------- */

/**
 * Marks a task as one that should never have existed.
 *
 * Not deletion -- the application role holds no DELETE privilege -- and not
 * "we are not doing this any more", which is what `status` and a note are for.
 *
 * Refused while anything still waits on it, and the count is taken inside the
 * transaction for the reason `voidCostCode` takes its own inside one: the
 * screen was rendered before the task that now waits on this one was added.
 * Leaving a live task pointing at a void row would leave a dependency that no
 * screen shows and the push would still walk.
 */
export async function voidTask(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidTaskFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TASK_LABELS, 'That void needs a reason.');

  let problem: string | null = null;
  let name: string | undefined;
  let projectId = '';
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          name: scheduleTasks.name,
          projectId: scheduleTasks.projectId,
          recordStatus: scheduleTasks.recordStatus,
        })
        .from(scheduleTasks)
        .where(eq(scheduleTasks.id, parsed.data.id));

      if (!row) {
        problem = 'That task no longer exists.';
        return;
      }
      if (row.recordStatus === 'void') {
        problem = 'That task is already void.';
        return;
      }
      projectId = row.projectId;
      name = row.name;

      await lockProject(tx, projectId);

      const dependents = await tx
        .select({ name: scheduleTasks.name })
        .from(scheduleTasks)
        .where(
          and(
            eq(scheduleTasks.predecessorTaskId, parsed.data.id),
            ne(scheduleTasks.recordStatus, 'void'),
          ),
        )
        .orderBy(asc(scheduleTasks.plannedStart));

      if (dependents.length > 0) {
        problem = `${dependents.map((task) => task.name).join(', ')} ${
          dependents.length === 1 ? 'waits' : 'wait'
        } on ${row.name}. Point ${dependents.length === 1 ? 'it' : 'them'} at something else first — a task waiting on a voided row is a dependency no screen would show and the push would still walk.`;
        return;
      }

      await tx
        .update(scheduleTasks)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
        })
        .where(eq(scheduleTasks.id, parsed.data.id));
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidatePath(`/projects/${projectId}/schedule`);
  return saved(`${name} is void. It is off the schedule and off the job's finish date, and the row stays.`);
}
