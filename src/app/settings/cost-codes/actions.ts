'use server';

import { count, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { costCodes, customerInvoiceLines, quoteLines, rateItems } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  COST_CODE_LABELS,
  costCodeFields,
  isDuplicateCode,
  parentProblem,
  toColumns,
} from '@/app/settings/cost-codes/schema';

/**
 * The cost code list's write side.
 *
 * The same three rules that run through `app/rates/actions.ts` run through
 * this file, for the same reasons.
 *
 * 1. **Authorization is a separate lookup, per request.** `guard(...)` reads
 *    the role out of `users` every time; nothing is taken from a form field or
 *    a claim. The refusal lives here rather than only in the screen, because a
 *    disabled button is a hint and a stale tab is not obliged to read it.
 * 2. **Nothing is deleted, and retiring is not voiding.** `is_active = false`
 *    says "do not offer this on new work" -- the trade is no longer used, the
 *    code is superseded. `record_status = 'void'` says "this row should never
 *    have existed". They are separate controls with separate wording, and a
 *    rate item, a quote line or an invoice line naming either one goes on
 *    resolving: `cost_code_id` is a foreign key to a row that never leaves.
 * 3. **Changing a cost code cannot move a quote.** Nothing here writes
 *    `quote_lines`, and no figure anywhere is read from this table.
 *
 * Where this file is deliberately stricter than the rate list is the third
 * rule's other half. A quote line snapshots a rate item's description and both
 * rates, so voiding a rate item costs a historical document nothing. It does
 * NOT snapshot the cost code -- `quote_lines.cost_code_id` is a live foreign
 * key, and `customer_invoice_lines.cost_code_id` is the same. So the name and
 * the standing of a cost code are resolved from this table forever, and
 * `voidCostCode` refuses a row that documents already point at. That is not
 * timidity: void means "a mistake", and a code that is already grouping spend
 * on an issued document was not a mistake. Retire is the control for taking it
 * out of circulation, and it is one press away.
 *
 * `rates:edit` is the capability for adding, editing and retiring, rather than
 * `organization:edit` or `tax:edit`. The cost code list is the taxonomy the
 * rate list is built against: an `admin` already assigns a cost code to a rate
 * item on `/rates`, and a matrix that let him do that but not create the code
 * he is assigning would refuse him halfway through one job. `record:void`
 * gates voiding, as it does everywhere else in the product, and a `bookkeeper`
 * holds neither.
 */

const REFUSAL = 'Your role does not permit changing the cost code list.';

/** A hierarchy rule broken, carried out of a transaction as a sentence. */
class HierarchyError extends Error {}

/** A void refused because the row is doing work. Same trip, same reason. */
class InUseError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof HierarchyError || error instanceof InUseError) return error.message;
  // Deliberately NOT `error.message`. Every write here runs inside a
  // transaction, and Drizzle wraps a driver error in a DrizzleQueryError whose
  // message is the failed SQL and its bound parameters. Putting that on the
  // screen tells the owner nothing he can act on and shows him the schema; the
  // server log still has the whole thing.
  return 'That change could not be saved. Nothing was written.';
}


/**
 * Why a code is already taken, said in full.
 *
 * The unique index is on the column and not on the live rows, so the row
 * holding the code may be retired, or void, and therefore not on the part of
 * the screen the person was looking at. Telling him only "that code is taken"
 * sends him hunting a row he cannot see.
 */
async function takenBy(code: string): Promise<string> {
  const [row] = await db
    .select({ name: costCodes.name, isActive: costCodes.isActive, recordStatus: costCodes.recordStatus })
    .from(costCodes)
    .where(eq(costCodes.code, code));

  if (!row) return `${code} is already taken.`;
  if (row.recordStatus === 'void') {
    // Not "edit that one": a void row is kept as a record and is not edited.
    return `${code} is held by a voided row — ${row.name}. Voiding does not free a code, because the unique index is on the column and not on the live rows, so the corrected code needs a number of its own.`;
  }
  if (!row.isActive) {
    return `${code} is held by a retired code — ${row.name}. A retired code keeps its code. Bring that one back if this is the same bucket, or choose another number.`;
  }
  return `${code} is already on the list — ${row.name}. Edit that one, or choose another number.`;
}

/* -------------------------------------------------------------------------
   One code at a time
   ------------------------------------------------------------------------- */

export async function createCostCode(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);

  const parsed = costCodeFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, COST_CODE_LABELS);
  const input = parsed.data;

  try {
    // One transaction, because the parent has to still be a division at the
    // moment of the insert and not merely at the moment of the check.
    await db.transaction(async (tx) => {
      if (input.parentId !== null) {
        const [parent] = await tx
          .select({
            id: costCodes.id,
            code: costCodes.code,
            parentId: costCodes.parentId,
            recordStatus: costCodes.recordStatus,
          })
          .from(costCodes)
          .where(eq(costCodes.id, input.parentId));

        const problem = parentProblem({ childId: null, childHasChildren: false, parent });
        if (problem) throw new HierarchyError(problem);
      }

      await tx.insert(costCodes).values({ ...toColumns(input), createdBy: allowed.actor.id });
    });
  } catch (error) {
    if (isDuplicateCode(error)) return refused(await takenBy(input.code));
    return refused(failureText(error));
  }

  revalidatePath('/settings/cost-codes');
  // The rate list reads this table for its cost code picker and its importer.
  revalidatePath('/rates');
  return saved(`${input.code} added. It is now offered wherever a cost code is chosen.`);
}

const withId = costCodeFields.extend({ id: z.uuid('is not a cost code') });

/**
 * Edits a code in place.
 *
 * In place, and not a supersede-with-dates the way a tax rate works. A tax
 * rate has to answer "what was the rate on this date" years later, so its
 * history is the record. A cost code is a label on a bucket: renaming
 * "Flooring" to "Floor finishes" is the same bucket, and every line already
 * filed in it should read the new name, not the old one. What must never
 * happen is the code being quietly reused for a DIFFERENT trade -- that
 * rewrites history rather than relabelling it -- which is why the screen says
 * so beside this form and why a superseded trade is retired instead.
 */
export async function updateCostCode(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, COST_CODE_LABELS);
  const { id, ...rest } = parsed.data;

  let code: string | undefined;
  try {
    code = await db.transaction(async (tx) => {
      if (rest.parentId !== null) {
        const [parent] = await tx
          .select({
            id: costCodes.id,
            code: costCodes.code,
            parentId: costCodes.parentId,
            recordStatus: costCodes.recordStatus,
          })
          .from(costCodes)
          .where(eq(costCodes.id, rest.parentId));

        const [children] = await tx
          .select({ n: count() })
          .from(costCodes)
          .where(eq(costCodes.parentId, id));

        const problem = parentProblem({
          childId: id,
          childHasChildren: (children?.n ?? 0) > 0,
          parent,
        });
        if (problem) throw new HierarchyError(problem);
      }

      const rows = await tx
        .update(costCodes)
        // `updated_at` is deliberately absent: a trigger maintains it, and a
        // value written here would be the one the sync cursor trusts.
        .set(toColumns(rest))
        .where(eq(costCodes.id, id))
        .returning({ code: costCodes.code });

      return rows[0]?.code;
    });
  } catch (error) {
    if (isDuplicateCode(error)) return refused(await takenBy(rest.code));
    return refused(failureText(error));
  }

  if (!code) return refused('That cost code no longer exists.');

  revalidatePath('/settings/cost-codes');
  revalidatePath('/rates');
  return saved(
    `${code} saved. Everything already filed under it — rate items, quote lines, invoice lines — reads the new name, because a line points at this row rather than copying it.`,
  );
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires a code, or brings it back.
 *
 * Not a deletion and not a void. A retired code stays on the list, keeps its
 * code -- which is why re-adding that code is still refused -- and goes on
 * resolving for every rate item, quote line and invoice line that names it.
 * What changes is that new work is no longer offered it.
 */
export async function setCostCodeActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);

  const parsed = activeFields.safeParse(formValues(formData));
  if (!parsed.success) return refused('That request did not make sense.');

  const rows = await db
    .update(costCodes)
    .set({ isActive: parsed.data.isActive })
    .where(eq(costCodes.id, parsed.data.id))
    .returning({ code: costCodes.code });

  const row = rows[0];
  if (!row) return refused('That cost code no longer exists.');

  revalidatePath('/settings/cost-codes');
  revalidatePath('/rates');
  return saved(
    parsed.data.isActive
      ? `${row.code} is back on the list for new work.`
      : `${row.code} is retired. It is no longer offered on new work, and it still names every line already filed under it.`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a code as one that should never have existed.
 *
 * The remedy for a code typed twice, or a division added under the wrong
 * number before anything used it. It is not a delete and it does not free the
 * code: the unique index is on the column, not on the live rows, so a voided
 * `02-40` still occupies `02-40`. That is said out loud in the confirmation,
 * because the obvious next move after voiding is to re-add the corrected code
 * under the same number.
 *
 * Refused for a code that documents already point at, or that has sections
 * filed under it. See the note at the top of this file: a cost code is not
 * snapshotted onto a line the way a rate is, so voiding one rewrites what an
 * issued quote or invoice says about itself.
 */
export async function voidCostCode(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, COST_CODE_LABELS, 'That void needs a reason.');

  let code: string | undefined;
  try {
    code = await db.transaction(async (tx) => {
      // Counted inside the writing transaction rather than read off the
      // screen: the screen was rendered before the quote that now uses this
      // code was written.
      const [onQuotes] = await tx
        .select({ n: count() })
        .from(quoteLines)
        .where(eq(quoteLines.costCodeId, parsed.data.id));
      const [onInvoices] = await tx
        .select({ n: count() })
        .from(customerInvoiceLines)
        .where(eq(customerInvoiceLines.costCodeId, parsed.data.id));
      const [sections] = await tx
        .select({ n: count() })
        .from(costCodes)
        .where(eq(costCodes.parentId, parsed.data.id));

      const documents = (onQuotes?.n ?? 0) + (onInvoices?.n ?? 0);
      if (documents > 0) {
        throw new InUseError(
          `This code already groups ${documents} ${documents === 1 ? 'line' : 'lines'} on quotes or invoices, so it is not a row that should never have existed. Retire it instead: that stops it being offered on new work and leaves those documents saying what they said.`,
        );
      }
      if ((sections?.n ?? 0) > 0) {
        throw new InUseError(
          `This code has ${sections?.n} ${sections?.n === 1 ? 'section' : 'sections'} filed under it. Void or move those first, or retire this one.`,
        );
      }

      const rows = await tx
        .update(costCodes)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
        })
        .where(eq(costCodes.id, parsed.data.id))
        .returning({ code: costCodes.code });

      return rows[0]?.code;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!code) return refused('That cost code no longer exists.');

  // Rate items may still point here. They keep pointing, and the rate list
  // shows the code as void rather than blanking the cell.
  const [stillOnRates] = await db
    .select({ n: count() })
    .from(rateItems)
    .where(eq(rateItems.costCodeId, parsed.data.id));

  revalidatePath('/settings/cost-codes');
  revalidatePath('/rates');
  return saved(
    `${code} is void. Its code stays taken, so a corrected division needs a code of its own.${
      (stillOnRates?.n ?? 0) > 0
        ? ` ${stillOnRates?.n} rate ${stillOnRates?.n === 1 ? 'item' : 'items'} still name it, and the rate list now shows it as void — give those another code.`
        : ''
    }`,
  );
}
