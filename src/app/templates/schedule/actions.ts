'use server';

import { and, eq, ne } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import { scheduleTemplates, scheduleTemplateTasks } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { findPredecessorCycle } from '@/lib/schedule/push';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  TASK_LABELS,
  TEMPLATE_LABELS,
  activeSchema,
  editTemplateTaskFields,
  hasSqlState,
  newTemplateTaskFields,
  updateScheduleTemplateSchema,
  voidTemplateTaskFields,
} from '@/app/templates/schedule/schema';

/**
 * The schedule template's write side -- spec
 * `docs/superpowers/specs/2026-09-05-schedule-templates-design.md`.
 *
 * Three rules carried over from the two screens this one was built to match:
 *
 * 1. **Capability, not a settings alias.** `src/app/settings/actor.ts` maps a
 *    handful of screen-local names onto the canonical matrix in
 *    `src/lib/auth/permissions.ts`, but that file is owned by another agent's
 *    work here and the design doc's own section 8 says the rename it wants
 *    (`scheduleTemplates.edit`) changes nothing observable yet -- `rates:edit`
 *    and `quote:write` already cover the same roles. So this calls `guard()`
 *    from `src/lib/auth/guard.ts` directly, with the canonical capability,
 *    exactly as `src/app/projects/[id]/schedule/actions.ts` does for the live
 *    schedule. Voiding takes `record:void`, named directly in the brief.
 * 2. **Nothing is deleted.** `record_status = 'void'` with a reason, same as
 *    everywhere else.
 * 3. **A cycle is refused on save**, via `findPredecessorCycle` from
 *    `src/lib/schedule/push.ts` -- widened (see that file) to read only
 *    `id`, `name` and `predecessorTaskId`, which is all a template task has to
 *    offer it. Only `updateTemplateTask` calls it: a brand-new row cannot
 *    already be part of a cycle, because nothing points at it yet -- the same
 *    reasoning `createTask` in the live schedule's own actions file relies on
 *    to skip the same check.
 */

function revalidateTemplate(id: string): void {
  revalidatePath(`/templates/schedule/${id}`);
  revalidatePath('/templates');
}

/**
 * Deliberately NOT `error.message` -- see the identical note in the live
 * schedule's own `actions.ts`. A driver error's message is the failed SQL and
 * its bound parameters, which tells nobody using this screen anything they can
 * act on.
 */
function failureText(error: unknown): string {
  if (hasSqlState(error, '23514')) {
    return 'That change breaks one of the rules a task has to keep — its duration, its lag, or its condition. Nothing was written.';
  }
  if (hasSqlState(error, '23503')) {
    return 'Something this task points at is no longer there. Reload the template and try again. Nothing was written.';
  }
  return 'That change could not be saved. Nothing was written.';
}

/* -------------------------------------------------------------------------
   The template itself: name, project type, description, active flag
   ------------------------------------------------------------------------- */

export async function updateScheduleTemplate(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = updateScheduleTemplateSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TEMPLATE_LABELS);
  const { id, ...patch } = parsed.data;

  const rows = await db
    .update(scheduleTemplates)
    .set(patch)
    .where(eq(scheduleTemplates.id, id))
    .returning({ id: scheduleTemplates.id });

  if (rows.length === 0) return refused('That schedule template no longer exists.');

  revalidateTemplate(id);
  return saved(`${patch.name} saved.`);
}

/**
 * Retires a schedule template, or brings it back. Nothing is deleted: a job
 * that already imported from this template keeps its own tasks regardless.
 */
export async function setScheduleTemplateActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = activeSchema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(scheduleTemplates)
    .set({ isActive: parsed.data.isActive })
    .where(eq(scheduleTemplates.id, parsed.data.id))
    .returning({ name: scheduleTemplates.name });

  if (rows.length === 0) return refused('That schedule template no longer exists.');

  revalidateTemplate(parsed.data.id);
  return saved(
    parsed.data.isActive ? `${rows[0]!.name} is available again.` : `${rows[0]!.name} retired.`,
  );
}

/* -------------------------------------------------------------------------
   Tasks
   ------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Every live task on this template, in the shape `findPredecessorCycle` reads. */
async function readTemplateTasks(
  tx: Tx,
  scheduleTemplateId: string,
): Promise<{ id: string; name: string; predecessorTaskId: string | null }[]> {
  return tx
    .select({
      id: scheduleTemplateTasks.id,
      name: scheduleTemplateTasks.name,
      predecessorTaskId: scheduleTemplateTasks.predecessorTaskId,
    })
    .from(scheduleTemplateTasks)
    .where(
      and(
        eq(scheduleTemplateTasks.scheduleTemplateId, scheduleTemplateId),
        ne(scheduleTemplateTasks.recordStatus, 'void'),
      ),
    );
}

/**
 * The two duration-scaling columns, resolved from what the form submitted
 * rather than trusted from it.
 *
 * A milestone collapses to `none`/0/null regardless of what sat in the
 * (CSS-hidden) duration fields when it was ticked -- section 5.1's "the
 * editor hides the duration fields for a milestone rather than collecting
 * values it will discard" is honoured here rather than merely on screen, the
 * same way the vendor screen drops a leftover trade id for a supplier rather
 * than trusting the browser to have hidden the box. Each other source nulls
 * the OTHER scaling column for the same reason `schedule_template_tasks`'s own
 * CHECK insists on it: a row can never hold both.
 */
function resolvedDuration(input: {
  isMilestone: boolean;
  durationSource: 'none' | 'area' | 'washrooms' | 'kitchens' | 'bedrooms';
  durationBaseDays: number;
  durationAreaPerDay: bigint | null;
  durationDaysPerUnit: number | null;
}): {
  durationBaseDays: number;
  durationSource: 'none' | 'area' | 'washrooms' | 'kitchens' | 'bedrooms';
  durationAreaPerDayMilli: bigint | null;
  durationDaysPerUnit: number | null;
} {
  if (input.isMilestone) {
    return { durationBaseDays: 0, durationSource: 'none', durationAreaPerDayMilli: null, durationDaysPerUnit: null };
  }
  if (input.durationSource === 'area') {
    return {
      durationBaseDays: input.durationBaseDays,
      durationSource: 'area',
      durationAreaPerDayMilli: input.durationAreaPerDay,
      durationDaysPerUnit: null,
    };
  }
  if (
    input.durationSource === 'washrooms' ||
    input.durationSource === 'kitchens' ||
    input.durationSource === 'bedrooms'
  ) {
    return {
      durationBaseDays: input.durationBaseDays,
      durationSource: input.durationSource,
      durationAreaPerDayMilli: null,
      durationDaysPerUnit: input.durationDaysPerUnit,
    };
  }
  return {
    durationBaseDays: input.durationBaseDays,
    durationSource: 'none',
    durationAreaPerDayMilli: null,
    durationDaysPerUnit: null,
  };
}

/** The condition columns, resolved the same way -- `conditionKind` decides
 *  which of the two nullable columns is ever written, so a hand-crafted
 *  request naming both cannot reach the database at all. */
function resolvedCondition(input: {
  conditionKind: 'none' | 'measurement' | 'rateItem';
  conditionMeasurement: 'washrooms' | 'kitchens' | 'bedrooms' | null;
  conditionRateItemId: string | null;
}): { conditionMeasurement: 'washrooms' | 'kitchens' | 'bedrooms' | null; conditionRateItemId: string | null } {
  return {
    conditionMeasurement: input.conditionKind === 'measurement' ? input.conditionMeasurement : null,
    conditionRateItemId: input.conditionKind === 'rateItem' ? input.conditionRateItemId : null,
  };
}

export async function createTemplateTask(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error);

  const scheduleTemplateId = String(formData.get('scheduleTemplateId') ?? '');
  const parsed = newTemplateTaskFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TASK_LABELS);
  const input = parsed.data;

  let problem: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const [template] = await tx
        .select({ id: scheduleTemplates.id, recordStatus: scheduleTemplates.recordStatus })
        .from(scheduleTemplates)
        .where(eq(scheduleTemplates.id, scheduleTemplateId));
      if (!template || template.recordStatus === 'void') {
        problem = 'That schedule template no longer exists.';
        return;
      }

      let predecessorTaskId: string | null = null;
      if (input.predecessorTaskId !== null) {
        const [predecessor] = await tx
          .select({ id: scheduleTemplateTasks.id, recordStatus: scheduleTemplateTasks.recordStatus })
          .from(scheduleTemplateTasks)
          .where(
            and(
              eq(scheduleTemplateTasks.id, input.predecessorTaskId),
              eq(scheduleTemplateTasks.scheduleTemplateId, scheduleTemplateId),
            ),
          );
        if (!predecessor || predecessor.recordStatus === 'void') {
          problem = 'That task no longer exists in this template.';
          return;
        }
        predecessorTaskId = predecessor.id;
      }

      // Section 5.3's "predecessor in the same template" is what the query
      // above already re-reads against; re-checked here rather than left to
      // the composite foreign key so a stale form gets a sentence instead of
      // a 23503.
      if (predecessorTaskId === null && input.lagDays !== 0) {
        problem =
          'A lag needs a task to lag behind — pick what this waits on, or set the lag back to zero.';
        return;
      }

      await tx.insert(scheduleTemplateTasks).values({
        scheduleTemplateId,
        name: input.name,
        tradeId: input.tradeId,
        costCodeId: input.costCodeId,
        notes: input.notes,
        sortOrder: input.sortOrder,
        isMilestone: input.isMilestone,
        ...resolvedDuration(input),
        predecessorTaskId,
        lagDays: predecessorTaskId === null ? 0 : input.lagDays,
        ...resolvedCondition(input),
        createdBy: allowed.actor.id,
      });
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidateTemplate(scheduleTemplateId);
  return saved(`${input.name} added.`);
}

export async function updateTemplateTask(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = editTemplateTaskFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TASK_LABELS);
  const input = parsed.data;

  let problem: string | null = null;
  let scheduleTemplateId = '';
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          scheduleTemplateId: scheduleTemplateTasks.scheduleTemplateId,
          recordStatus: scheduleTemplateTasks.recordStatus,
        })
        .from(scheduleTemplateTasks)
        .where(eq(scheduleTemplateTasks.id, input.id));

      if (!row) {
        problem = 'That task no longer exists.';
        return;
      }
      if (row.recordStatus === 'void') {
        problem = 'This task is void. A void row is kept as a record and is not edited.';
        return;
      }
      scheduleTemplateId = row.scheduleTemplateId;

      let predecessorTaskId: string | null = null;
      if (input.predecessorTaskId !== null) {
        const [predecessor] = await tx
          .select({ id: scheduleTemplateTasks.id, recordStatus: scheduleTemplateTasks.recordStatus })
          .from(scheduleTemplateTasks)
          .where(
            and(
              eq(scheduleTemplateTasks.id, input.predecessorTaskId),
              eq(scheduleTemplateTasks.scheduleTemplateId, scheduleTemplateId),
            ),
          );
        if (!predecessor || predecessor.recordStatus === 'void') {
          problem = 'That task no longer exists in this template.';
          return;
        }
        predecessorTaskId = predecessor.id;
      }

      if (predecessorTaskId === null && input.lagDays !== 0) {
        problem =
          'A lag needs a task to lag behind — pick what this waits on, or set the lag back to zero.';
        return;
      }

      // Section 5.3: "a cycle is refused on save using findPredecessorCycle
      // ... It reads only id, name and predecessorTaskId." Includes THIS row
      // with its proposed (not yet written) predecessor, which is exactly how
      // `updateTask` checks the live schedule's own chain.
      const tasks = await readTemplateTasks(tx, scheduleTemplateId);
      const cycle = findPredecessorCycle(tasks, input.id, predecessorTaskId);
      if (cycle) {
        problem =
          cycle.length === 1
            ? `${input.name} cannot wait on itself.`
            : `That would make these tasks wait on each other in a loop — ${cycle.join(' → ')} — and a loop has no order to work in. Break one of those links first.`;
        return;
      }

      await tx
        .update(scheduleTemplateTasks)
        .set({
          name: input.name,
          tradeId: input.tradeId,
          costCodeId: input.costCodeId,
          notes: input.notes,
          sortOrder: input.sortOrder,
          isMilestone: input.isMilestone,
          ...resolvedDuration(input),
          predecessorTaskId,
          lagDays: predecessorTaskId === null ? 0 : input.lagDays,
          ...resolvedCondition(input),
        })
        .where(eq(scheduleTemplateTasks.id, input.id));
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidateTemplate(scheduleTemplateId);
  return saved(`${input.name} saved.`);
}

/**
 * Voids a template task -- refused while live dependents exist, matching
 * `voidTask` in `src/app/projects/[id]/schedule/actions.ts`. Same wording
 * shape, because the failure mode is identical: a task waiting on a voided
 * row is a dependency no screen would show, whether that row belongs to a
 * job's own schedule or the template a job might later import from.
 */
export async function voidTemplateTask(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidTemplateTaskFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TASK_LABELS, 'That void needs a reason.');

  let problem: string | null = null;
  let name: string | undefined;
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ name: scheduleTemplateTasks.name, recordStatus: scheduleTemplateTasks.recordStatus })
        .from(scheduleTemplateTasks)
        .where(eq(scheduleTemplateTasks.id, parsed.data.id));

      if (!row) {
        problem = 'That task no longer exists.';
        return;
      }
      if (row.recordStatus === 'void') {
        problem = 'That task is already void.';
        return;
      }
      name = row.name;

      const dependents = await tx
        .select({ name: scheduleTemplateTasks.name })
        .from(scheduleTemplateTasks)
        .where(
          and(
            eq(scheduleTemplateTasks.predecessorTaskId, parsed.data.id),
            ne(scheduleTemplateTasks.recordStatus, 'void'),
          ),
        );

      if (dependents.length > 0) {
        problem = `${dependents.map((task) => task.name).join(', ')} ${
          dependents.length === 1 ? 'waits' : 'wait'
        } on ${row.name}. Point ${dependents.length === 1 ? 'it' : 'them'} at something else first — a task waiting on a voided row is a dependency no import would show and this template would still carry.`;
        return;
      }

      await tx
        .update(scheduleTemplateTasks)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
        })
        .where(eq(scheduleTemplateTasks.id, parsed.data.id));
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (problem) return refused(problem);

  revalidateTemplate(parsed.data.scheduleTemplateId);
  return saved(`${name} is void, off the template.`);
}
