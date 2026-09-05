'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { lineGroups } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  LINE_GROUP_LABELS,
  isDuplicateName,
  lineGroupFields,
  toLineGroupColumns,
} from '@/app/settings/line-groups/schema';

/**
 * The line group list's write side.
 *
 * The same three rules that run through `app/settings/trades/actions.ts` run
 * through this file, for the same reasons.
 *
 * 1. **Authorization is a separate lookup, per request.** `guard(...)` reads
 *    the role out of `users` every time; nothing is taken from a form field or
 *    a claim. The refusal lives here rather than only in the screen, because a
 *    disabled button is a hint and a stale tab is not obliged to read it.
 * 2. **Nothing is deleted, and retiring is not voiding.** `is_active = false`
 *    says "do not offer this on a new line" -- a heading this company has
 *    stopped using. `record_status = 'void'` says "this row should never have
 *    existed".
 * 3. **Void carries no in-use guard**, unlike `voidTrade`. A trade is a
 *    foreign key on every vendor that carries it, so voiding one has to be
 *    refused while a vendor still points at its id. `line_group` on a scope
 *    template item, a quote line and an invoice line is still plain text --
 *    see `db/schema/line-groups.ts` -- so no row anywhere points at THIS
 *    table's id yet, and there is nothing for a void to leave dangling. That
 *    changes only if a later migration turns the free-text columns into a
 *    foreign key, at which point this file gains the same guard `trades`
 *    already has.
 *
 * `rates:edit` for adding, editing and retiring; `record:void` for voiding.
 * Both follow the trade list and the cost code list.
 */

const REFUSAL = 'Your role does not permit changing the line group list.';

function failureText(_error: unknown): string {
  // Deliberately NOT `error.message`: Drizzle wraps a driver error in a
  // DrizzleQueryError whose message is the failed SQL and its bound
  // parameters, which tells the owner nothing and shows him the schema.
  return 'That change could not be saved. Nothing was written.';
}

/**
 * Why a name is already taken, said in full.
 *
 * The unique index is on `lower(name)` and not on the live rows, so the row
 * holding the name may be retired, or void, and therefore not on the part of
 * the screen the person was looking at.
 */
async function takenBy(name: string): Promise<string> {
  const [row] = await db
    .select({
      name: lineGroups.name,
      isActive: lineGroups.isActive,
      recordStatus: lineGroups.recordStatus,
    })
    .from(lineGroups)
    .where(sql`lower(${lineGroups.name}) = lower(${name})`);

  if (!row) return `${name} is already taken.`;
  if (row.recordStatus === 'void') {
    return `${row.name} is held by a voided row. Voiding does not free a name, because the unique index is on the column and not on the live rows, so a corrected line group needs a name of its own.`;
  }
  if (!row.isActive) {
    return `${row.name} is already on the list as a retired line group. Bring that one back rather than adding a second row.`;
  }
  return `${row.name} is already on the list. Edit that one, or choose another name.`;
}

/* -------------------------------------------------------------------------
   One line group at a time
   ------------------------------------------------------------------------- */

export async function createLineGroup(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = lineGroupFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, LINE_GROUP_LABELS);
  const input = parsed.data;

  try {
    await db
      .insert(lineGroups)
      .values({ ...toLineGroupColumns(input), createdBy: allowed.actor.id });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(input.name));
    return refused(failureText(error));
  }

  revalidatePath('/settings/line-groups');
  return saved(`${input.name} added.`);
}

const withId = lineGroupFields.extend({ id: z.uuid('is not a line group') });

/**
 * Edits a line group in place.
 *
 * In place, and not a supersede-with-dates the way a tax rate works. A rename
 * reaches every scope template item, quote line and invoice line already
 * printing this heading -- once that wiring is added -- the same way renaming
 * a trade reaches every subcontractor already filed under it.
 *
 * What must never happen is the row being quietly reused for a DIFFERENT
 * heading. The screen says so beside the form, and retire is the control for a
 * heading this company no longer uses.
 */
export async function updateLineGroup(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, LINE_GROUP_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    const rows = await db
      .update(lineGroups)
      // `updated_at` is deliberately absent: a trigger maintains it, and a
      // value written here would be the one the sync cursor trusts.
      .set(toLineGroupColumns(rest))
      .where(eq(lineGroups.id, id))
      .returning({ name: lineGroups.name });
    name = rows[0]?.name;
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(rest.name));
    return refused(failureText(error));
  }

  if (!name) return refused('That line group no longer exists.');

  revalidatePath('/settings/line-groups');
  return saved(`${name} saved.`);
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires a line group, or brings it back.
 *
 * Not a deletion and not a void. A retired line group stays on the list,
 * keeps its name -- which is why re-adding that name is still refused -- and
 * goes on being what an existing printed heading matches against once that
 * wiring exists. What changes is that it is no longer offered on a new line.
 */
export async function setLineGroupActive(
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
    .update(lineGroups)
    .set({ isActive: parsed.data.isActive })
    .where(eq(lineGroups.id, parsed.data.id))
    .returning({ name: lineGroups.name });

  const row = rows[0];
  if (!row) return refused('That line group no longer exists.');

  revalidatePath('/settings/line-groups');
  return saved(
    parsed.data.isActive ? `${row.name} is back on the list.` : `${row.name} is retired.`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a line group as one that should never have existed.
 *
 * The remedy for a name typed twice, or a heading added under a spelling
 * nobody uses. It is not a delete and it does not free the name. See the note
 * at the top of this file for why this action, unlike `voidTrade`, needs no
 * in-use count first: nothing yet points at this row's id.
 */
export async function voidLineGroup(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, LINE_GROUP_LABELS, 'That void needs a reason.');

  let name: string | undefined;
  try {
    const rows = await db
      .update(lineGroups)
      .set({
        recordStatus: 'void',
        voidedAt: new Date(),
        voidedBy: allowed.actor.id,
        voidReason: parsed.data.reason,
        // `is_active` is deliberately left alone, as `voidTrade` leaves it
        // alone. The two columns answer two different questions.
      })
      .where(eq(lineGroups.id, parsed.data.id))
      .returning({ name: lineGroups.name });
    name = rows[0]?.name;
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That line group no longer exists.');

  revalidatePath('/settings/line-groups');
  return saved(`${name} is void. Its name stays taken.`);
}
