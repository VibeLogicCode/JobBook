'use server';

import { count, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { projects, projectTypes, scheduleTemplates, scopeTemplates } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  PROJECT_TYPE_LABELS,
  isDuplicateName,
  projectTypeFields,
  toProjectTypeColumns,
} from '@/app/settings/project-lists';

/**
 * The project type list's write side.
 *
 * The same three rules that run through `app/settings/trades/actions.ts` run
 * through this file, for the same reasons: authorization is a separate
 * per-request lookup, nothing is ever deleted, and a void is refused for a row
 * anything still points at.
 *
 * Where this differs from trades: THREE tables carry `project_type_id`
 * (`projects`, `scope_templates`, `schedule_templates`), all `NOT NULL`, so
 * "is this row in use" is a sum across three counts rather than one. Retiring
 * never needs the count -- it never blocks -- but voiding does, and the count
 * is taken inside the same transaction as the void for the reason
 * `voidTrade` takes its own inside one: the screen was rendered before
 * whichever of those three rows now carries it was saved.
 *
 * `rates:edit` for adding, editing and retiring; `record:void` for voiding.
 * Same capability as trades and vendor types -- a reference list priced and
 * scheduled records point at, maintained by whoever runs the work.
 */

const REFUSAL = 'Your role does not permit changing the project type list.';

/** A void refused because the row is doing work, carried out as a sentence. */
class InUseError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof InUseError) return error.message;
  return 'That change could not be saved. Nothing was written.';
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** How many projects, scope templates and schedule templates carry this row. */
async function usage(
  id: string,
  executor: Executor = db,
): Promise<{ projects: number; scopeTemplates: number; scheduleTemplates: number; total: number }> {
  const [[projectRow], [scopeRow], [scheduleRow]] = await Promise.all([
    executor.select({ n: count() }).from(projects).where(eq(projects.projectTypeId, id)),
    executor.select({ n: count() }).from(scopeTemplates).where(eq(scopeTemplates.projectTypeId, id)),
    executor.select({ n: count() }).from(scheduleTemplates).where(eq(scheduleTemplates.projectTypeId, id)),
  ]);
  const p = projectRow?.n ?? 0;
  const s = scopeRow?.n ?? 0;
  const t = scheduleRow?.n ?? 0;
  return { projects: p, scopeTemplates: s, scheduleTemplates: t, total: p + s + t };
}

/** "3 projects, 1 scope template and 2 schedule templates" -- only the parts that are non-zero. */
function usagePhrase(u: { projects: number; scopeTemplates: number; scheduleTemplates: number }): string {
  const parts = [
    u.projects > 0 ? `${u.projects} ${u.projects === 1 ? 'project' : 'projects'}` : '',
    u.scopeTemplates > 0 ? `${u.scopeTemplates} scope ${u.scopeTemplates === 1 ? 'template' : 'templates'}` : '',
    u.scheduleTemplates > 0
      ? `${u.scheduleTemplates} schedule ${u.scheduleTemplates === 1 ? 'template' : 'templates'}`
      : '',
  ].filter(Boolean);
  if (parts.length === 0) return 'nothing yet';
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts[0]}, ${parts[1]} and ${parts[2]}`;
}

/**
 * Why a name is already taken, said in full -- matching `takenBy` in
 * `trades/actions.ts`.
 */
async function takenBy(name: string): Promise<string> {
  const [row] = await db
    .select({
      name: projectTypes.name,
      isActive: projectTypes.isActive,
      recordStatus: projectTypes.recordStatus,
    })
    .from(projectTypes)
    .where(sql`lower(${projectTypes.name}) = lower(${name})`);

  if (!row) return `${name} is already taken.`;
  if (row.recordStatus === 'void') {
    return `${row.name} is held by a voided row. Voiding does not free a name, because the unique index is on the column and not on the live rows, so a corrected project type needs a name of its own.`;
  }
  if (!row.isActive) {
    return `${row.name} is already on the list as a retired project type. Bring that one back rather than adding a second row — every record already filed under it is on the row that exists.`;
  }
  return `${row.name} is already on the list. Edit that one, or choose another name.`;
}

/* -------------------------------------------------------------------------
   One project type at a time
   ------------------------------------------------------------------------- */

export async function createProjectType(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = projectTypeFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, PROJECT_TYPE_LABELS);
  const input = parsed.data;

  try {
    await db
      .insert(projectTypes)
      .values({ ...toProjectTypeColumns(input), createdBy: allowed.actor.id });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(input.name));
    return refused(failureText(error));
  }

  revalidatePath('/settings/project-types');
  revalidatePath('/projects');
  revalidatePath('/templates');
  return saved(`${input.name} added.`);
}

const withId = projectTypeFields.extend({ id: z.uuid('is not a project type') });

/**
 * Edits a project type in place, matching `updateTrade`: a rename reaches
 * every project, scope template and schedule template already filed under
 * it, and retire is the control for a type this company has stopped offering.
 */
export async function updateProjectType(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, PROJECT_TYPE_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    const rows = await db
      .update(projectTypes)
      .set(toProjectTypeColumns(rest))
      .where(eq(projectTypes.id, id))
      .returning({ name: projectTypes.name });
    name = rows[0]?.name;
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(rest.name));
    return refused(failureText(error));
  }

  if (!name) return refused('That project type no longer exists.');

  revalidatePath('/settings/project-types');
  revalidatePath('/projects');
  revalidatePath('/templates');
  return saved(`${name} saved.`);
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires a project type, or brings it back. Never blocked by usage: retiring
 * only stops it being offered on new work.
 */
export async function setProjectTypeActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = activeFields.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(projectTypes)
    .set({ isActive: parsed.data.isActive })
    .where(eq(projectTypes.id, parsed.data.id))
    .returning({ name: projectTypes.name });

  const row = rows[0];
  if (!row) return refused('That project type no longer exists.');

  const stillOn = await usage(parsed.data.id);

  revalidatePath('/settings/project-types');
  revalidatePath('/projects');
  revalidatePath('/templates');
  return saved(
    parsed.data.isActive
      ? `${row.name} is back on the list.`
      : `${row.name} is retired.${stillOn.total > 0 ? ` ${usagePhrase(stillOn)} still ${stillOn.total === 1 ? 'shows' : 'show'} it.` : ''}`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a project type as one that should never have existed. Refused while
 * any project, scope template or schedule template carries it -- counted
 * inside the writing transaction, the same reasoning as `voidTrade`.
 */
export async function voidProjectType(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, PROJECT_TYPE_LABELS, 'That void needs a reason.');

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      const inUse = await usage(parsed.data.id, tx);

      if (inUse.total > 0) {
        throw new InUseError(
          `${usagePhrase(inUse)} ${inUse.total === 1 ? 'carries' : 'carry'} this project type, so it is not a row that should never have existed. Retire it instead: that stops it being offered when something new is added, and everything already on it goes on showing it.`,
        );
      }

      const rows = await tx
        .update(projectTypes)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
        })
        .where(eq(projectTypes.id, parsed.data.id))
        .returning({ name: projectTypes.name });

      return rows[0]?.name;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That project type no longer exists.');

  revalidatePath('/settings/project-types');
  revalidatePath('/projects');
  revalidatePath('/templates');
  return saved(`${name} is void. Its name stays taken.`);
}
