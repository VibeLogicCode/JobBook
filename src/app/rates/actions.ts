'use server';

import { asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { costCodes, rateItems } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import { RATE_LABELS, rateItemFields, toColumns } from '@/app/rates/schema';
import { rateImportMappingSchema } from '@/lib/import/mapping';
import { planImport } from '@/lib/import/preview';
import { ImportLimitError, toGrid } from '@/lib/import/text';

/**
 * The rate list's write side.
 *
 * Three rules run through every action here.
 *
 * 1. **Authorization is a separate lookup, per request.** `guard('rates:edit')`
 *    reads the role out of `users` every time; nothing is taken from a form
 *    field or a claim. The refusal lives here rather than only in the screen,
 *    because a disabled button is a hint and a hand-made POST is not obliged
 *    to read it.
 * 2. **Nothing is deleted, and retiring is not voiding.** `is_active = false`
 *    says "do not offer this on new quotes"; `record_status = 'void'` says
 *    "this row should never have existed". They are different events about
 *    different things and are never collapsed into one control -- a quote line
 *    naming a retired item must still resolve, and so must one naming a voided
 *    one.
 * 3. **Editing a rate item cannot move a quote.** Nothing in this file writes
 *    `quote_lines`, and nothing reads `rate_items` to price one. A quote line
 *    snapshots its description, its cost code and both rates when it is
 *    created; `rate_item_id` on that line is provenance and is never followed
 *    for a figure. `tests/db/rate-snapshot.test.ts` holds that line, because
 *    the failure would be silent and would rewrite documents already sent.
 */

const REFUSAL = 'Your role does not permit changing the rate list.';

function failureText(error: unknown): string {
  if (error instanceof ImportLimitError) return error.message;
  return error instanceof Error ? error.message : 'That change failed.';
}

/**
 * Postgres's unique-violation SQLSTATE. Caught rather than pre-checked because
 * a check followed by an insert is two statements with a gap between them, and
 * the gap is where the second tab's insert lands.
 */
function isDuplicateCode(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/* -------------------------------------------------------------------------
   One item at a time
   ------------------------------------------------------------------------- */

export async function createRateItem(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = rateItemFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, RATE_LABELS);

  try {
    await db.insert(rateItems).values({ ...toColumns(parsed.data), createdBy: allowed.actor.id });
  } catch (error) {
    if (isDuplicateCode(error)) {
      return refused(
        `A rate item already uses the code ${parsed.data.code}. Codes are unique across the one list, so edit that item instead.`,
      );
    }
    return refused(failureText(error));
  }

  revalidatePath('/rates');
  return saved(`${parsed.data.code} added.`);
}

const withId = rateItemFields.extend({ id: z.uuid('is not a rate item') });

/**
 * Edits an item in place.
 *
 * In place, and not a supersede-with-dates the way a tax rate works, because
 * the two protect different things. A tax rate has to answer "what was the
 * rate on this date" years later, so its history is the record. A rate item's
 * history is already carried by every quote line that snapshotted it -- there
 * is nothing here for a second copy to protect, and a list that grew a new row
 * every time a supplier moved a price would be unusable within a year.
 */
export async function updateRateItem(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, RATE_LABELS);
  const { id, ...rest } = parsed.data;

  let rows;
  try {
    rows = await db
      .update(rateItems)
      // `updated_at` is deliberately absent: a trigger maintains it, and a
      // value written here would be the one the sync cursor trusts.
      .set(toColumns(rest))
      .where(eq(rateItems.id, id))
      .returning({ code: rateItems.code, recordStatus: rateItems.recordStatus });
  } catch (error) {
    if (isDuplicateCode(error)) {
      return refused(`A rate item already uses the code ${rest.code}.`);
    }
    return refused(failureText(error));
  }

  const row = rows[0];
  if (!row) return refused('That rate item no longer exists.');

  revalidatePath('/rates');
  return saved(
    `${row.code} saved. Quotes already written keep the price they were built at — every line snapshots its rates.`,
  );
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires an item, or brings it back.
 *
 * Not a deletion and not a void. A retired item stays on the list, keeps its
 * code -- which is why re-importing that code is still refused -- and goes on
 * resolving for every quote line and template line that names it.
 */
export async function setRateItemActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = activeFields.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(rateItems)
    .set({ isActive: parsed.data.isActive })
    .where(eq(rateItems.id, parsed.data.id))
    .returning({ code: rateItems.code });

  const row = rows[0];
  if (!row) return refused('That rate item no longer exists.');

  revalidatePath('/rates');
  return saved(
    parsed.data.isActive
      ? `${row.code} is back on the list for new quotes.`
      : `${row.code} is retired. It stays on every quote that already uses it.`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks an item as one that should never have existed.
 *
 * The remedy for an import that landed forty wrong rows. It is not a delete
 * and does not free the code: the unique index is on the column, not on the
 * live rows, so a voided `DEM-01` still occupies `DEM-01`. That is said out
 * loud in the confirmation, because the obvious next move after voiding is to
 * re-import the corrected line under the same code.
 */
export async function voidRateItem(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, RATE_LABELS, 'That void needs a reason.');

  const rows = await db
    .update(rateItems)
    .set({
      recordStatus: 'void',
      voidedAt: new Date(),
      voidedBy: allowed.actor.id,
      voidReason: parsed.data.reason,
    })
    .where(eq(rateItems.id, parsed.data.id))
    .returning({ code: rateItems.code });

  const row = rows[0];
  if (!row) return refused('That rate item no longer exists.');

  revalidatePath('/rates');
  return saved(
    `${row.code} is void. Its code stays taken, so a corrected line needs a code of its own.`,
  );
}

/* -------------------------------------------------------------------------
   The importer
   ------------------------------------------------------------------------- */

const importFields = z.object({
  text: z.string().min(1, 'is required'),
  delimiter: z.enum([',', '\t', ';', '|']).optional(),
  mapping: z.string().min(1),
});

/**
 * Commits a pasted or uploaded price list.
 *
 * The preview the person approved was drawn in the browser by `planImport`;
 * this re-runs the SAME function on the server, against the codes and cost
 * codes read inside the writing transaction. Not because the browser is
 * expected to lie, but because between the preview and the press of the button
 * another tab can have added a code -- and because a server action that trusts
 * a plan posted to it is a server action that will insert whatever a plan says.
 *
 * One transaction, so a file that is half-legal lands whole or not at all.
 */
export async function importRateItems(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);

  const parsedForm = importFields.safeParse(formValues(formData));
  if (!parsedForm.success) return refused('There was nothing to import.');

  let mapping;
  try {
    mapping = rateImportMappingSchema.parse(JSON.parse(parsedForm.data.mapping));
  } catch {
    return refused('The column choices did not survive the trip. Set them again and retry.');
  }

  try {
    const summary = await db.transaction(async (tx) => {
      const { rows: grid } = toGrid(parsedForm.data.text, parsedForm.data.delimiter);

      const existing = await tx.select({ code: rateItems.code }).from(rateItems);
      const codes = await tx
        .select({ id: costCodes.id, code: costCodes.code, name: costCodes.name })
        .from(costCodes)
        .where(eq(costCodes.recordStatus, 'active'))
        .orderBy(asc(costCodes.code));

      const plan = planImport(grid, mapping, {
        existingCodes: existing.map((row) => row.code),
        costCodes: codes,
      });

      if (plan.problems.length > 0) throw new Error(plan.problems[0]!);

      const toCreate = plan.rows.flatMap((row) => (row.outcome === 'create' ? [row.item] : []));
      if (toCreate.length > 0) {
        await tx
          .insert(rateItems)
          .values(toCreate.map((item) => ({ ...item, createdBy: allowed.actor.id })));
      }

      return { created: toCreate.length, skipped: plan.skipCount };
    });

    revalidatePath('/rates');
    return saved(
      summary.created === 0
        ? `Nothing was created. ${summary.skipped} ${summary.skipped === 1 ? 'row was' : 'rows were'} skipped — the reasons are beside each row above.`
        : `${summary.created} rate ${summary.created === 1 ? 'item' : 'items'} created${
            summary.skipped > 0 ? `, ${summary.skipped} skipped` : ''
          }. Quotes already written are untouched.`,
    );
  } catch (error) {
    if (isDuplicateCode(error)) {
      return refused(
        'One of those codes was taken while the preview was on screen, so nothing was imported. Reload and preview again.',
      );
    }
    return refused(failureText(error));
  }
}
