'use server';

import { and, count, desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import { customers, projects, quotes, stageHistory } from '@/db/schema';
import { allocateDocumentNumber } from '@/lib/quote/numbering';
import type { FormResult } from '@/components/detail/form-state';
import { guard } from '@/lib/auth/guard';
import {
  PROJECT_STAGES,
  type ProjectStage,
  stagesOpenTo,
} from '@/components/detail/labels';
import { projectTypeProblem } from '@/lib/project-lists/guards';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'that value is too long')
    .optional()
    .transform((value) => (value === undefined || value === '' ? null : value));

/**
 * A date input posts `YYYY-MM-DD` or nothing at all, and the column is a
 * `date`, so the value stays a plain ISO string end to end. Parsing it into a
 * `Date` on the way through would drag a timezone into a value that has none,
 * and a scheduled start would land a day early in a UTC container.
 */
const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === undefined || value === '' ? null : value))
  .refine((value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value), 'that is not a date');

const projectFields = z
  .object({
    customerId: z.string().uuid('choose a customer'),
    name: z.string().trim().min(1, 'this needs a name').max(200, 'that name is too long'),
    projectTypeId: z.uuid('choose a type of work'),
    contractType: z
      .enum(['lump_sum', 'unit_price', 'cost_plus', 'time_and_material'])
      .optional()
      .or(z.literal(''))
      .transform((value) => (value === '' || value === undefined ? null : value)),
    siteAddressLine1: optionalText(200),
    siteCity: optionalText(120),
    // No default province in the schema and none here: that would hardcode a
    // tenant's region. The UI defaults it from the organization record.
    siteProvince: optionalText(40),
    sitePostalCode: optionalText(20),
    scheduledStart: optionalDate,
    scheduledEnd: optionalDate,
    actualStart: optionalDate,
    actualEnd: optionalDate,
    substantialPerformanceDate: optionalDate,
    certificatePublishedDate: optionalDate,
  })
  // ISO dates compare correctly as strings, so a reversed pair is caught here
  // rather than surfacing months later as a negative duration on a report.
  .refine(
    (value) => !value.scheduledStart || !value.scheduledEnd
      || value.scheduledEnd >= value.scheduledStart,
    'the scheduled end cannot come before the scheduled start',
  )
  .refine(
    (value) => !value.actualStart || !value.actualEnd || value.actualEnd >= value.actualStart,
    'the actual end cannot come before the actual start',
  );

const withId = z.object({ id: z.string().uuid('that record id is not valid') });

const stageFields = withId
  .extend({
    stage: z.enum(
      [
        'lead', 'site_visit', 'quoting', 'quote_sent', 'won',
        'lost', 'in_progress', 'complete', 'on_hold',
      ],
      'choose a stage',
    ),
    lostReason: optionalText(300),
    holdReason: optionalText(300),
  })
  // A lost bid with no reason recorded teaches nothing, and it is never
  // remembered a week later.
  .refine(
    (value) => value.stage !== 'lost' || value.lostReason !== null,
    'say why it was lost',
  )
  // On hold is the stage a job disappears into. Without a reason, three months
  // later nobody knows whether it is waiting on a permit, on the customer's
  // financing, or on a decision somebody owes an answer to -- and the ones
  // waiting on us are the ones worth chasing.
  .refine(
    (value) => value.stage !== 'on_hold' || value.holdReason !== null,
    'say what it is waiting on',
  );

function fields(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function firstProblem(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'that did not make sense';
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : 'that change failed';
}


export async function createProject(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = projectFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  let id: string;
  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const [customer] = await db
      .select({ recordStatus: customers.recordStatus })
      .from(customers)
      .where(eq(customers.id, parsed.data.customerId));
    if (!customer) return { ok: false, error: 'that customer no longer exists' };
    if (customer.recordStatus !== 'active') {
      return { ok: false, error: 'that customer is void, so no new work can be booked to it' };
    }

    // The number is allocated inside the same transaction as the insert, so a
    // job that fails to save does not burn a number out of the series.
    id = await db.transaction(async (tx) => {
      const problem = await projectTypeProblem(tx, parsed.data.projectTypeId);
      if (problem) throw new Error(problem);

      const projectNumber = await allocateDocumentNumber(tx, 'project');
      const [row] = await tx
        .insert(projects)
        .values({ ...parsed.data, projectNumber })
        .returning({ id: projects.id });
      if (!row) throw new Error('the job was not saved');
      return row.id;
    });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath('/projects');
  // Outside the try, because redirect signals by throwing.
  redirect(`/projects/${id}`);
}

/**
 * Edits a job. Stage is not among the columns written here: it has its own
 * action, so that every stage change is a deliberate one.
 */
export async function updateProject(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const raw = fields(formData);
  const id = withId.safeParse(raw);
  if (!id.success) return { ok: false, error: firstProblem(id.error) };

  const parsed = projectFields.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const [existing] = await db.select().from(projects).where(eq(projects.id, id.data.id));
    if (!existing) return { ok: false, error: 'that job no longer exists' };
    if (existing.recordStatus !== 'active') {
      return { ok: false, error: 'this job is void and cannot be edited' };
    }

    await db.transaction(async (tx) => {
      const problem = await projectTypeProblem(tx, parsed.data.projectTypeId);
      if (problem) throw new Error(problem);
      await tx.update(projects).set(parsed.data).where(eq(projects.id, id.data.id));
    });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath('/projects');
  revalidatePath(`/projects/${id.data.id}`);
  redirect(`/projects/${id.data.id}`);
}

/**
 * Moves a job to another stage.
 *
 * Only the stage column is written; the `stage_history` row that records the
 * move is written by a database trigger, so a change made from a script or a
 * future code path cannot skip the history either.
 */
export async function setProjectStage(
  _state: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const parsed = stageFields.safeParse(fields(formData));
  if (!parsed.success) return { ok: false, error: firstProblem(parsed.error) };
  const { id, stage, lostReason, holdReason } = parsed.data;

  try {
    const allowed = await guard('quote:write');
    if (!allowed.ok) return { ok: false, error: allowed.error };

    const [existing] = await db.select().from(projects).where(eq(projects.id, id));
    if (!existing) return { ok: false, error: 'that job no longer exists' };
    if (existing.recordStatus !== 'active') {
      return { ok: false, error: 'this job is void, so its stage cannot change' };
    }
    if (existing.stage === stage) return { ok: true };

    // Which stages are legal depends on whether this record has been won, and
    // that is a database question rather than a form question: the dropdown
    // that produced this value is a hint, and a stale tab or a hand-made POST
    // carries whatever it likes.
    //
    // `won` is refused outright. A job exists because a quote on it was
    // accepted; setting the stage by hand would manufacture a job with no
    // accepted quote behind it -- no contract value, no agreed lines, nothing
    // to invoice against -- and the stage history would show it winning
    // without ever having been quoted.
    const [{ accepted } = { accepted: 0 }] = await db
      .select({ accepted: count(quotes.id) })
      .from(quotes)
      .where(
        and(
          eq(quotes.projectId, id),
          eq(quotes.status, 'accepted'),
          eq(quotes.recordStatus, 'active'),
        ),
      );
    const isJob = Number(accepted) > 0;

    if (stage === 'won') {
      return {
        ok: false,
        error:
          'Winning is not a stage you set. Accept a quote on this opportunity — that is what ' +
          'turns it into a job, and it also records which lines the customer agreed to.',
      };
    }

    if (!stagesOpenTo(isJob, existing.stage as ProjectStage).includes(stage)) {
      return {
        ok: false,
        error: isJob
          ? `This is a job: work has been won on it, so it cannot go back to ${
              PROJECT_STAGES[stage]
            }. Void the accepted quote if it was accepted in error.`
          : `This is an opportunity: nothing has been won on it yet, so it cannot be ${
              PROJECT_STAGES[stage]
            }. Accept a quote first.`,
      };
    }

    // The reason lands on the stage_history ROW, not in a column on the
    // project, because a job can go on hold three times for three different
    // reasons and one column would overwrite the history. `lost_reason` stays
    // on the project as well: it is the current reason the screen shows while
    // a bid is lost, and it predates this.
    //
    // stage_history rows are written by a trigger, so the note is applied to
    // the row the trigger just created, inside the same transaction that
    // caused it.
    const note = stage === 'lost' ? lostReason : stage === 'on_hold' ? holdReason : null;

    await db.transaction(async (tx) => {
      await tx
        .update(projects)
        // The reason is written only on a move INTO lost. A move back out
        // leaves the recorded reason alone -- it is what happened -- and the
        // screen shows it only while the bid is actually lost.
        .set({ stage, ...(stage === 'lost' ? { lostReason } : {}) })
        .where(eq(projects.id, id));

      if (note) {
        const [written] = await tx
          .select({ id: stageHistory.id })
          .from(stageHistory)
          .where(eq(stageHistory.projectId, id))
          .orderBy(desc(stageHistory.changedAt), desc(stageHistory.id))
          .limit(1);
        if (written) {
          await tx.update(stageHistory).set({ note }).where(eq(stageHistory.id, written.id));
        }
      }
    });
  } catch (error) {
    return { ok: false, error: failureText(error) };
  }

  revalidatePath('/projects');
  revalidatePath(`/projects/${id}`);
  return { ok: true };
}
