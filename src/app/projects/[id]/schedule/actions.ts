'use server';

import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import {
  assignments,
  costCodes,
  organization,
  projects,
  quotes,
  scheduleTasks,
  scheduleTemplates,
  scheduleTemplateTasks,
  trades,
  users,
  vendors,
} from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { lagBetween } from '@/lib/schedule/calendar';
import {
  canonicalScheduleText,
  describeMove,
  findPredecessorCycle,
  planMove,
  type ScheduleTask,
} from '@/lib/schedule/push';
import { planImport, type PlannedTask, type Scope, type TemplateTask } from '@/lib/schedule/template';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid, isoDate } from '@/app/settings/validate';
import {
  ASSIGNMENT_LABELS,
  TASK_LABELS,
  clashSentence,
  dayFormatter,
  duplicateAssignmentText,
  editAssignmentFields,
  editTaskFields,
  hasSqlState,
  heldRows,
  moveFields,
  newAssignmentFields,
  newTaskFields,
  overlapDays,
  previewRows,
  removeAssignmentFields,
  voidTaskFields,
  type Assignee,
  type MoveState,
  type Span,
} from '@/app/projects/[id]/schedule/schema';
import { findEngagements, toClash } from '@/app/projects/[id]/schedule/clashes';

/**
 * The two screens a schedule write is visible on.
 *
 * The job's own screen is the obvious one. `/calendar` is the other, and it is
 * easy to forget precisely because it belongs to no job: it draws every job at
 * once, so a task moved here changes a page whose address contains nothing
 * that identifies this project. Revalidating it at the source rather than
 * refreshing from the client means the calendar is right for anybody who has
 * it open, not only for the person who happened to make the edit.
 */
function revalidateSchedule(projectId: string): void {
  revalidatePath(`/projects/${projectId}/schedule`);
  revalidatePath('/calendar');
}


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

/** The columns a chosen trade is judged on, and nothing else. */
const TRADE_REF = { id: trades.id, name: trades.name, recordStatus: trades.recordStatus };

/**
 * Whether a trade may be pointed at, said in a sentence.
 *
 * Void is refused and retired is allowed, the same asymmetry `vendors/schema.ts`
 * draws for a vendor's own trade. Retiring is a statement about NEW work: a
 * task already pointing at "Roofing" goes on pointing at it, and re-saving a
 * task for an unrelated reason must not force it off a trade that still
 * stands just because the trade list is winding it down.
 *
 * Read inside the writing transaction, never off the form, for the reason
 * `predecessorProblem` is: the picker was built before a trade voided since
 * was voided.
 */
async function tradeProblem(tx: Tx, tradeId: string | null): Promise<string | null> {
  if (tradeId === null) return null;
  const [trade] = await tx.select(TRADE_REF).from(trades).where(eq(trades.id, tradeId));
  if (!trade) return 'The trade you chose is not on the list.';
  if (trade.recordStatus === 'void') {
    return `${trade.name} is void, so new work should not be pointed at it. Choose a trade that still stands, or leave this blank.`;
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

      const tradeIssue = await tradeProblem(tx, input.tradeId);
      if (tradeIssue) {
        problem = tradeIssue;
        return;
      }

      await tx.insert(scheduleTasks).values({
        projectId,
        name: input.name,
        tradeId: input.tradeId,
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

  revalidateSchedule(projectId);
  return saved(
    input.predecessorTaskId === null
      ? `${input.name} added.`
      : `${input.name} added. It moves when its predecessor does.`,
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

      const tradeIssue = await tradeProblem(tx, input.tradeId);
      if (tradeIssue) {
        problem = tradeIssue;
        return;
      }

      await tx
        .update(scheduleTasks)
        // No `updatedAt`: the trigger owns it. No planned dates: those move
        // through `moveTaskDates`, which shows what else goes with them first.
        .set({
          name: input.name,
          tradeId: input.tradeId,
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

  revalidateSchedule(projectId);
  return saved(
    input.actualStart === null
      ? `${input.name} saved.`
      : `${input.name} saved. The auto-push will leave its dates alone.`,
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

  if (outcome.status === 'saved' && projectId) revalidateSchedule(projectId);
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

  revalidateSchedule(projectId);
  return saved(`${name} is void, off the schedule and the finish date.`);
}

/* -------------------------------------------------------------------------
   Importing a schedule template -- spec
   docs/superpowers/specs/2026-09-05-schedule-templates-design.md, section 7.
   ------------------------------------------------------------------------- */

export type ApplyTemplateResult = { ok: true; message: string } | { ok: false; error: string };

const applyTemplateSchema = z.object({
  projectId: z.uuid('is not a job'),
  templateId: z.uuid('is not a template'),
  startDate: isoDate,
  tickedTemplateTaskIds: z.array(z.uuid()).min(1, 'Tick at least one task to import.'),
});

/**
 * The accepted estimate's measurements -- section 6.2, and the correction the
 * spec makes twice: a change order carries none, so only sequence 1 is read
 * here. Zero, never null, when there is no accepted estimate at all, because
 * `durationDaysOf` multiplies by these and a null would need its own branch
 * for a job this action already has a sentence for (a stale ticked id, caught
 * before this is ever called).
 */
async function readScope(tx: Tx, projectId: string): Promise<Scope> {
  const [estimate] = await tx
    .select({
      washroomCount: quotes.washroomCount,
      kitchenCount: quotes.kitchenCount,
      bedroomCount: quotes.bedroomCount,
      areaSqftMilli: quotes.areaSqftMilli,
    })
    .from(quotes)
    .where(
      and(
        eq(quotes.projectId, projectId),
        eq(quotes.kind, 'estimate'),
        eq(quotes.sequence, 1),
        eq(quotes.status, 'accepted'),
        eq(quotes.recordStatus, 'active'),
      ),
    );
  return {
    areaSqftMilli: estimate?.areaSqftMilli ?? 0n,
    washroomCount: estimate?.washroomCount ?? 0,
    kitchenCount: estimate?.kitchenCount ?? 0,
    bedroomCount: estimate?.bedroomCount ?? 0,
  };
}

/**
 * Applies a schedule template to a job.
 *
 * A direct call rather than a `FormAction`, matching `acceptQuote` in
 * `src/app/quotes/[id]/actions.ts`: the sheet already computed the preview it
 * is asking this to write, so there is no form to build for something the
 * client already holds typed -- only the three facts section 7.5 says the
 * request may carry.
 *
 * **Posted dates are never trusted.** This re-reads the template's live
 * tasks and this job's scope INSIDE the transaction and calls `planImport`
 * again, so the write is the output of the same pure engine the sheet
 * previewed with, run against data read a moment before it is used rather
 * than data that travelled from the browser. The only things taken from the
 * request are which tasks were ticked and which date to start from -- the two
 * facts only a person can supply.
 *
 * A ticked id that is no longer live -- voided from the template since the
 * sheet opened -- is refused in one sentence, the way `moveTaskDates` refuses
 * a fingerprint the schedule has moved out from under.
 *
 * Template task ids never reach `schedule_tasks`: each planned row gets a
 * fresh id, generated here rather than left to the column default, so a
 * dependent can be inserted pointing at its predecessor's real row before
 * either exists in the database. `ensureInserted` walks the chain rather than
 * looping over `planned` in its `sort_order` -- section 5.2's own point, that
 * a task may sort above its own predecessor, applies to insert order exactly
 * as it applies to dates.
 */
export async function applyScheduleTemplate(
  input: z.input<typeof applyTemplateSchema>,
): Promise<ApplyTemplateResult> {
  const parsed = applyTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That request did not make sense.' };
  }
  const { projectId, templateId, startDate, tickedTemplateTaskIds } = parsed.data;

  const allowed = await guard('quote:write');
  if (!allowed.ok) {
    return { ok: false, error: allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error };
  }
  // Captured as a plain value rather than read off `allowed` again below: the
  // deepest write happens inside `ensureInserted`, a function declared inside
  // the transaction and called recursively, and TypeScript does not carry a
  // narrowed union across that many function boundaries.
  const actorId = allowed.actor.id;

  let outcome: ApplyTemplateResult;
  try {
    outcome = await db.transaction(async (tx): Promise<ApplyTemplateResult> => {
      const [project] = await tx
        .select({ id: projects.id, recordStatus: projects.recordStatus })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project || project.recordStatus === 'void') {
        return { ok: false, error: 'That job no longer exists.' };
      }

      await lockProject(tx, projectId);

      const [template] = await tx
        .select({
          id: scheduleTemplates.id,
          name: scheduleTemplates.name,
          recordStatus: scheduleTemplates.recordStatus,
        })
        .from(scheduleTemplates)
        .where(eq(scheduleTemplates.id, templateId));
      if (!template || template.recordStatus === 'void') {
        return { ok: false, error: 'That schedule template no longer exists.' };
      }

      const templateTaskRows = await tx
        .select()
        .from(scheduleTemplateTasks)
        .where(
          and(
            eq(scheduleTemplateTasks.scheduleTemplateId, templateId),
            ne(scheduleTemplateTasks.recordStatus, 'void'),
          ),
        );

      const liveIds = new Set(templateTaskRows.map((row) => row.id));
      if (tickedTemplateTaskIds.some((id) => !liveIds.has(id))) {
        return {
          ok: false,
          error: `${template.name} changed since you opened this sheet — one of the tasks you ticked is no longer on it. Reopen Import from template and try again.`,
        };
      }

      const tasks: TemplateTask[] = templateTaskRows.map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sortOrder,
        isMilestone: row.isMilestone,
        durationBaseDays: row.durationBaseDays,
        durationSource: row.durationSource,
        durationAreaPerDayMilli: row.durationAreaPerDayMilli,
        durationDaysPerUnit: row.durationDaysPerUnit,
        predecessorTaskId: row.predecessorTaskId,
        lagDays: row.lagDays,
        conditionMeasurement: row.conditionMeasurement,
        conditionRateItemId: row.conditionRateItemId,
      }));

      const scope = await readScope(tx, projectId);
      const ticked = new Set(tickedTemplateTaskIds);
      const planned = planImport(tasks, ticked, scope, startDate);

      // Every ticked id was just confirmed live, so this is unreachable in
      // practice -- kept as the sentence rather than a silent no-op, the same
      // choice `moveTaskDates` makes for its own "nothing to do" case.
      if (planned.length === 0) {
        return { ok: false, error: 'Tick at least one task to import.' };
      }

      // "Where an imported task's name already exists on the schedule, one
      // line says so" (section 7.5) -- the cheap guard against importing the
      // same template twice. Read BEFORE this import's own inserts, so a
      // template with two tasks sharing a name does not flag itself.
      const existingNames = new Set(
        (
          await tx
            .select({ name: scheduleTasks.name })
            .from(scheduleTasks)
            .where(and(eq(scheduleTasks.projectId, projectId), ne(scheduleTasks.recordStatus, 'void')))
        ).map((row) => row.name),
      );
      const duplicateNames = [
        ...new Set(planned.filter((row) => existingNames.has(row.name)).map((row) => row.name)),
      ];

      const templateTaskById = new Map(templateTaskRows.map((row) => [row.id, row]));
      const plannedByTemplateTaskId = new Map(planned.map((row) => [row.templateTaskId, row]));
      const dbIdByTemplateTaskId = new Map<string, string>();

      async function ensureInserted(row: PlannedTask): Promise<string> {
        const already = dbIdByTemplateTaskId.get(row.templateTaskId);
        if (already) return already;

        let predecessorDbId: string | null = null;
        if (row.predecessorTemplateTaskId !== null) {
          predecessorDbId = await ensureInserted(
            plannedByTemplateTaskId.get(row.predecessorTemplateTaskId)!,
          );
        }

        const source = templateTaskById.get(row.templateTaskId)!;
        const id = randomUUID();
        dbIdByTemplateTaskId.set(row.templateTaskId, id);

        await tx.insert(scheduleTasks).values({
          id,
          projectId,
          name: row.name,
          tradeId: source.tradeId,
          costCodeId: source.costCodeId,
          plannedStart: row.start,
          plannedEnd: row.end,
          isMilestone: source.isMilestone,
          // Roots get lagDays 0 straight from planImport -- effectiveLink's own
          // rule -- so lag_needs_predecessor never sees a lag with nothing to
          // lag behind.
          predecessorTaskId: predecessorDbId,
          lagDays: row.lagDays,
          sortOrder: source.sortOrder,
          notes: source.notes,
          createdBy: actorId,
        });
        return id;
      }

      for (const row of planned) await ensureInserted(row);

      const count = planned.length;
      const base = `${count} ${count === 1 ? 'task' : 'tasks'} added from ${template.name}.`;
      const message =
        duplicateNames.length === 0
          ? base
          : `${base} ${andListTemplate(duplicateNames)} ${
              duplicateNames.length === 1 ? 'already exists' : 'already exist'
            } on this schedule.`;

      return { ok: true, message };
    });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  if (outcome.ok) revalidateSchedule(projectId);
  return outcome;
}

/** "Framing and Drywall", for the duplicate-name note above. */
function andListTemplate(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/* -------------------------------------------------------------------------
   Assignments: who is doing the task
   ------------------------------------------------------------------------- */

/**
 * `quote:write`, the same capability the rest of this screen takes, and the
 * choice is worth stating because one column on the row is money.
 *
 * An `agreed_amount_cents` is not a ledger line. It is what was agreed for a
 * task on a plan, and what is actually paid is an `expenses` row against the
 * vendor with paper behind it -- which is the record `expense:write` exists
 * for, and the reason a bookkeeper holds that capability and not this one.
 * Assigning is editing the job's plan: an `owner` and an `admin` do it, and a
 * `bookkeeper` reads the whole screen and changes none of it, because whoever
 * prepares the year end must never be able to restate who was on site.
 *
 * `record:void` is not taken by any action here. Removing somebody from a task
 * is NOT voiding -- see the note on `assignments.removed_at` -- and voiding a
 * mis-keyed assignment has no control on this screen yet, so the capability is
 * not asked for by something that cannot happen.
 */

/** Who an assignment is for, resolved and judged inside the writing transaction. */
interface ResolvedAssignee {
  /** What the screen and the refusals call them. */
  name: string;
  /** The sentence saying why they may not be assigned, or null. */
  problem: string | null;
}

/**
 * Whether this person may be put on a task, decided from the CURRENT row.
 *
 * Read inside the transaction and never off the form, for the reason the
 * predecessor check is: the picker was built before the vendor was retired, and
 * a stale tab does not read a list it never re-fetched.
 *
 * The subcontractor rule is here rather than in a check constraint because
 * `is_subcontractor` lives on another table and a CHECK may not read one. It is
 * the one rule in this file the database cannot hold, so it is stated once,
 * where the write happens.
 */
async function resolveAssignee(tx: Tx, assignee: Assignee): Promise<ResolvedAssignee> {
  if (assignee.kind === 'vendor') {
    const [row] = await tx
      .select({
        name: vendors.name,
        isSubcontractor: vendors.isSubcontractor,
        isActive: vendors.isActive,
        recordStatus: vendors.recordStatus,
      })
      .from(vendors)
      .where(eq(vendors.id, assignee.id));

    if (!row) return { name: 'That vendor', problem: 'That vendor is not on the list.' };
    if (row.recordStatus === 'void') {
      return {
        name: row.name,
        problem: `${row.name} is a voided row, which means it should never have existed. Nobody can be scheduled against it.`,
      };
    }
    if (!row.isSubcontractor) {
      return {
        name: row.name,
        problem: `${row.name} is a supplier rather than a subcontractor, and a supplier is not assigned to a task — a lumber yard delivers, it does not turn up and do the work. Mark them as a subcontractor on the vendor list if that is wrong.`,
      };
    }
    if (!row.isActive) {
      return {
        name: row.name,
        problem: `${row.name} is retired, which means "do not offer this on new work". Bring them back on the vendor list first if they are working again. Assignments already recorded against them are untouched and still read.`,
      };
    }
    return { name: row.name, problem: null };
  }

  const [row] = await tx
    .select({
      name: users.displayName,
      isActive: users.isActive,
      recordStatus: users.recordStatus,
    })
    .from(users)
    .where(eq(users.id, assignee.id));

  if (!row) return { name: 'That person', problem: 'That person is not on the list.' };
  if (row.recordStatus === 'void') {
    return { name: row.name, problem: `${row.name} is a voided row and cannot be scheduled.` };
  }
  if (!row.isActive) {
    return {
      name: row.name,
      problem: `${row.name} has been deactivated. Reactivate them under Settings if they are back.`,
    };
  }
  return { name: row.name, problem: null };
}

/**
 * The double-booking warning, computed after the row is written.
 *
 * AFTER, deliberately. This is not a gate -- see the long note on
 * `clashSentence` for why refusing would be wrong -- so computing it first
 * would only be a reason to hold the write open longer. It runs inside the same
 * transaction so the sentence describes the schedule the row actually landed
 * in, and it excludes this task, which the new row itself now occupies.
 */
async function clashText(
  tx: Tx,
  assignee: Assignee,
  span: Span,
  taskId: string,
  projectId: string,
  who: string,
): Promise<string> {
  const engagements = await findEngagements(tx, [assignee], span);
  const clashes = engagements
    .filter((engagement) => engagement.taskId !== taskId)
    .map((engagement) => toClash(engagement, overlapDays(span, engagement.span)))
    .filter((clash) => clash.days > 0);
  return clashSentence(who, clashes, projectId);
}

/** The task an assignment hangs off, and whether it may be written against. */
async function readTaskForAssignment(
  tx: Tx,
  taskId: string,
): Promise<
  | { ok: false; problem: string }
  | { ok: true; projectId: string; name: string; span: Span }
> {
  const [task] = await tx
    .select({
      projectId: scheduleTasks.projectId,
      name: scheduleTasks.name,
      plannedStart: scheduleTasks.plannedStart,
      plannedEnd: scheduleTasks.plannedEnd,
      recordStatus: scheduleTasks.recordStatus,
    })
    .from(scheduleTasks)
    .where(eq(scheduleTasks.id, taskId));

  if (!task) return { ok: false, problem: 'That task no longer exists.' };
  if (task.recordStatus === 'void') {
    return {
      ok: false,
      problem: 'That task is void, so it is a record rather than work anybody can be put on.',
    };
  }
  if (await projectIsVoid(tx, task.projectId)) {
    return { ok: false, problem: 'That job is void, so its schedule is a record rather than a plan.' };
  }
  return {
    ok: true,
    projectId: task.projectId,
    name: task.name,
    span: { start: task.plannedStart, end: task.plannedEnd },
  };
}

/**
 * Puts a subcontractor, or somebody internal, on a task.
 *
 * No advisory lock: this write touches no dependency, so there is no chain to
 * walk and nothing for `lockProject` to serialise. What it does race against is
 * the same person being added twice from two tabs, and that is held by the
 * partial unique index rather than by a read -- a read followed by an insert is
 * two statements with a gap between them, and the gap is where the second
 * insert lands.
 */
export async function assignToTask(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('quote:write');
  if (!allowed.ok) return refusedResult(allowed.error);

  const parsed = newAssignmentFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, ASSIGNMENT_LABELS);
  const input = parsed.data;

  let problem: string | null = null;
  let message = '';
  let projectId = '';
  try {
    await db.transaction(async (tx) => {
      const task = await readTaskForAssignment(tx, input.scheduleTaskId);
      if (!task.ok) {
        problem = task.problem;
        return;
      }
      projectId = task.projectId;

      const who = await resolveAssignee(tx, input.assignee);
      if (who.problem) {
        problem = who.problem;
        return;
      }

      await tx.insert(assignments).values({
        scheduleTaskId: input.scheduleTaskId,
        vendorId: input.assignee.kind === 'vendor' ? input.assignee.id : null,
        userId: input.assignee.kind === 'user' ? input.assignee.id : null,
        agreedAmountCents: input.agreedAmount,
        notes: input.notes,
        createdBy: allowed.actor.id,
      });

      const clash = await clashText(
        tx,
        input.assignee,
        task.span,
        input.scheduleTaskId,
        task.projectId,
        who.name,
      );
      // "Awaiting confirmation" is deliberately not "declined" — asked-and-no-
      // answer has to stay distinguishable from a no.
      message = clash
        ? `${who.name} is on ${task.name}. ${clash}`
        : `${who.name} is on ${task.name}. Awaiting confirmation.`;
    });
  } catch (error) {
    // The partial unique index, said in full: the row already holding this
    // person may have arrived from another tab since this screen was drawn.
    if (hasSqlState(error, '23505')) {
      return refused(duplicateAssignmentText('That person'));
    }
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidateSchedule(projectId);
  return saved(message);
}

/**
 * What was heard back, what was agreed, and what was said on the phone.
 *
 * WHO is not editable here, and that is deliberate rather than an omission.
 * Swapping the person on an assignment would silently rewrite the record of who
 * was asked and when -- the confirmation, the agreed figure and the removal
 * reason would all survive onto somebody who never had them. Changing who is on
 * a task is removing one assignment and adding another, which leaves both
 * facts on the schedule where a year-later question can read them.
 *
 * It also means this form never re-renders the assignee picker, so the
 * stale-select problem the cost code picker guards against -- a `defaultValue`
 * matching no option, silently showing the first one, and the next save
 * recoding the row to whatever sorted first -- cannot arise here at all.
 */
export async function updateAssignment(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('quote:write');
  if (!allowed.ok) return refusedResult(allowed.error);

  const parsed = editAssignmentFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, ASSIGNMENT_LABELS);
  const input = parsed.data;

  let problem: string | null = null;
  let message = '';
  let projectId = '';
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          scheduleTaskId: assignments.scheduleTaskId,
          vendorId: assignments.vendorId,
          userId: assignments.userId,
          confirmedAt: assignments.confirmedAt,
          declinedAt: assignments.declinedAt,
          removedAt: assignments.removedAt,
          recordStatus: assignments.recordStatus,
        })
        .from(assignments)
        .where(eq(assignments.id, input.id));

      if (!row) {
        problem = 'That assignment no longer exists.';
        return;
      }
      if (row.recordStatus === 'void') {
        problem = 'That assignment is void. A void row is kept as a record and is not edited.';
        return;
      }
      if (row.removedAt !== null) {
        problem =
          'That person has been taken off this task, and the row is the record of it. Add them again if they are back on.';
        return;
      }

      const task = await readTaskForAssignment(tx, row.scheduleTaskId);
      if (!task.ok) {
        problem = task.problem;
        return;
      }
      projectId = task.projectId;

      // The three states, mapped back onto the two dates -- and an existing
      // stamp is KEPT rather than refreshed, so saving a note against a
      // confirmed assignment does not move the day he said yes.
      const now = new Date();
      const confirmedAt =
        input.response === 'confirmed' ? (row.confirmedAt ?? now) : null;
      const declinedAt = input.response === 'declined' ? (row.declinedAt ?? now) : null;

      await tx
        .update(assignments)
        // No `updatedAt`: the trigger owns it.
        .set({
          confirmedAt,
          declinedAt,
          agreedAmountCents: input.agreedAmount,
          notes: input.notes,
        })
        .where(eq(assignments.id, input.id));

      // A no is kept on the row rather than cleared, so the schedule still
      // shows that somebody asked; "not heard back" stays a different state
      // from "said no" for the same reason it does in `assignToTask`.
      message =
        input.response === 'confirmed'
          ? 'Saved, recorded as confirmed.'
          : input.response === 'declined'
            ? 'Saved, recorded as a no.'
            : 'Saved. No response recorded yet.';
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidateSchedule(projectId);
  return saved(message);
}

/**
 * Takes somebody off a task.
 *
 * NOT a delete -- the application role holds no DELETE privilege at all -- and
 * NOT a void. Void says the row should never have existed; this says the
 * arrangement ended, which is an ordinary thing that happens to a schedule and
 * is worth keeping. The distinction is the one the cost code list already draws
 * between retiring and voiding, applied to a row that records an event rather
 * than a reference.
 *
 * What it costs to be wrong about that is asymmetric, which is why it is worth
 * the extra column. Voiding a declined assignment would destroy the only
 * evidence the owner ever asked; a removal that should have been a void is a
 * row on screen saying so, with a reason on it.
 */
export async function removeAssignment(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('quote:write');
  if (!allowed.ok) return refusedResult(allowed.error);

  const parsed = removeAssignmentFields.safeParse(formValues(formData));
  if (!parsed.success) {
    return invalid(parsed.error, ASSIGNMENT_LABELS, 'Taking somebody off needs a reason.');
  }
  const input = parsed.data;

  let problem: string | null = null;
  let projectId = '';
  let who = 'They';
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          scheduleTaskId: assignments.scheduleTaskId,
          vendorName: vendors.name,
          userName: users.displayName,
          removedAt: assignments.removedAt,
          recordStatus: assignments.recordStatus,
        })
        .from(assignments)
        // Left joins, and both of them: exactly one is set, and the one that
        // is set may be a retired or voided vendor -- which still resolves,
        // because the column is a foreign key to a row that never leaves.
        .leftJoin(vendors, eq(vendors.id, assignments.vendorId))
        .leftJoin(users, eq(users.id, assignments.userId))
        .where(eq(assignments.id, input.id));

      if (!row) {
        problem = 'That assignment no longer exists.';
        return;
      }
      if (row.recordStatus === 'void') {
        problem = 'That assignment is void, so there is nobody on the task to take off.';
        return;
      }
      if (row.removedAt !== null) {
        problem = 'They have already been taken off this task.';
        return;
      }
      who = row.vendorName ?? row.userName ?? 'They';

      const task = await readTaskForAssignment(tx, row.scheduleTaskId);
      if (!task.ok) {
        problem = task.problem;
        return;
      }
      projectId = task.projectId;

      await tx
        .update(assignments)
        .set({
          removedAt: new Date(),
          removedBy: allowed.actor.id,
          removalReason: input.reason,
        })
        .where(eq(assignments.id, input.id));
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidateSchedule(projectId);
  return saved(`${who} is off this task, free again on the schedule.`);
}
