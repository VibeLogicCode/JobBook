'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { costCodes, vendors } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  VENDOR_LABELS,
  costCodeProblem,
  isDuplicateName,
  toColumns,
  vendorFields,
} from '@/app/vendors/schema';

/**
 * The vendor directory's write side.
 *
 * The same three rules that run through `app/rates/actions.ts` and
 * `app/settings/cost-codes/actions.ts` run through this file, for the same
 * reasons.
 *
 * 1. **Authorization is a separate lookup, per request.** `guard(...)` reads
 *    the role out of `users` every time; nothing is taken from a form field or
 *    a claim. The refusal lives here rather than only in the screen, because a
 *    disabled button is a hint, and neither a stale tab nor a hand-made POST
 *    is obliged to read it.
 * 2. **Nothing is deleted, and retiring is not voiding.** `is_active = false`
 *    says "do not offer this on new work" -- the sub retired, the supplier
 *    closed. `record_status = 'void'` says "this row should never have
 *    existed". They are separate controls with separate wording, and either
 *    way the row goes on resolving for every expense, assignment and T5018
 *    total that will name it: `vendor_id` will be a foreign key to a row that
 *    never leaves. The database role holds no DELETE privilege at all.
 * 3. **Changing a vendor cannot restate a filing.** Nothing here writes a
 *    figure, and no amount anywhere is read from this table.
 *
 * `rates:edit` is the capability for adding, editing and retiring, rather than
 * `quote:write` or `organization:edit`. The reasoning is the same one that put
 * the cost code list on it: this is a reference list that priced records point
 * at, maintained by whoever runs the work rather than by whoever owns the
 * company. An `admin` hires a subcontractor and needs the row to exist that
 * afternoon; a `bookkeeper` prepares the year end and must be able to READ
 * every vendor -- which the page allows, because reading is not gated here --
 * without being able to invent a counterparty a payment could be attributed
 * to. `record:void` gates voiding, as it does everywhere else in the product,
 * and a `bookkeeper` holds neither.
 *
 * **What is deliberately NOT here yet.** `voidVendor` does not refuse a vendor
 * that other records point at, the way `voidCostCode` refuses a code already
 * grouping invoice lines. It cannot: nothing references `vendors` yet.
 * `expenses.vendor_id` and `assignments.vendor_id` are steps 2 and 5 of the
 * job-costs plan, and the count belongs inside the transaction below the
 * moment either exists. Until then the honest position is that void is
 * unguarded here, and retire is the control the screen pushes toward.
 */

const REFUSAL = 'Your role does not permit changing the vendor list.';

/** A rule about the default cost code, carried out of a transaction as a sentence. */
class ProposalError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof ProposalError) return error.message;
  // Deliberately NOT `error.message`. Every write here runs inside a
  // transaction, and Drizzle wraps a driver error in a DrizzleQueryError whose
  // message is the failed SQL and its bound parameters. Putting that on the
  // screen tells the owner nothing he can act on and shows him the schema; the
  // server log still has the whole thing.
  return 'That change could not be saved. Nothing was written.';
}

/**
 * Why a name is already taken, said in full.
 *
 * The unique index is on `lower(name)` and not on the live rows, so the row
 * holding the name may be retired, or void, and therefore not the part of the
 * screen the person was looking at. Telling him only "that name is taken"
 * sends him hunting a row he cannot see -- and the list this table exists to
 * prevent is exactly the one he would then create by adding "Sample Supply
 * (2)".
 */
async function takenBy(name: string): Promise<string> {
  const [row] = await db
    .select({
      name: vendors.name,
      isActive: vendors.isActive,
      recordStatus: vendors.recordStatus,
      isSubcontractor: vendors.isSubcontractor,
    })
    .from(vendors)
    .where(sql`lower(${vendors.name}) = lower(${name})`);

  if (!row) return `${name} is already taken.`;
  const what = row.isSubcontractor ? 'subcontractor' : 'supplier';
  if (row.recordStatus === 'void') {
    // Not "edit that one": a void row is kept as a record and is not edited.
    return `${row.name} is held by a voided row. Voiding does not free a name, because the unique index is on the column and not on the live rows — so a corrected record needs a name that distinguishes it, and a name that distinguishes it is the one somebody wanted anyway.`;
  }
  if (!row.isActive) {
    return `${row.name} is already on the list as a retired ${what}. Bring that one back rather than adding a second row — every expense and payment already recorded against them is on the row that exists.`;
  }
  return `${row.name} is already on the list as a ${what}. Edit that one. Two rows for one counterparty is the thing this list exists to prevent: a T5018 total split across them is short on both.`;
}

/** The columns a proposed default cost code is judged on, and nothing else. */
const COST_CODE_REF = {
  id: costCodes.id,
  code: costCodes.code,
  name: costCodes.name,
  isActive: costCodes.isActive,
  recordStatus: costCodes.recordStatus,
};

/* -------------------------------------------------------------------------
   One vendor at a time
   ------------------------------------------------------------------------- */

export async function createVendor(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = vendorFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, VENDOR_LABELS);
  const input = parsed.data;

  try {
    // One transaction, because the proposed cost code has to still stand at
    // the moment of the insert and not merely at the moment of the check.
    await db.transaction(async (tx) => {
      if (input.defaultCostCodeId !== null) {
        // Read inside the transaction rather than off the screen: the screen
        // was rendered before the code that has since been voided was voided.
        const [code] = await tx
          .select(COST_CODE_REF)
          .from(costCodes)
          .where(eq(costCodes.id, input.defaultCostCodeId));

        const problem = costCodeProblem(code);
        if (problem) throw new ProposalError(problem);
      }

      await tx.insert(vendors).values({ ...toColumns(input), createdBy: allowed.actor.id });
    });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(input.name));
    return refused(failureText(error));
  }

  revalidatePath('/vendors');
  return saved(
    input.isSubcontractor
      ? `${input.name} added as a subcontractor. They will be offered wherever work is assigned, and they are on the list of people a T5018 is filed for — which is why the business number is worth chasing now rather than in February.`
      : `${input.name} added as a supplier. They will be offered wherever spend is coded. No T5018 is filed for a supplier, and no WSIB clearance is asked of one.`,
  );
}

const withId = vendorFields.extend({ id: z.uuid('is not a vendor') });

/**
 * Edits a vendor in place.
 *
 * In place, and not a supersede-with-dates the way a tax rate works. A tax
 * rate has to answer "what was the rate on this date" years later, so its
 * history is the record. A vendor is a counterparty: a new phone number is
 * the same counterparty, and every expense already recorded against them
 * should read the new one.
 *
 * What must never happen is the row being quietly repointed at a DIFFERENT
 * counterparty -- renaming "Sample Supply" to "Sample Masonry" because the
 * first one closed -- which rewrites who was paid rather than correcting how
 * they are reached. The screen says so beside the form, and retire is the
 * control for a counterparty you have stopped using.
 */
export async function updateVendor(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, VENDOR_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      if (rest.defaultCostCodeId !== null) {
        const [code] = await tx
          .select(COST_CODE_REF)
          .from(costCodes)
          .where(eq(costCodes.id, rest.defaultCostCodeId));

        const problem = costCodeProblem(code);
        if (problem) throw new ProposalError(problem);
      }

      const rows = await tx
        .update(vendors)
        // `updated_at` is deliberately absent: a trigger maintains it, and a
        // value written here would be the one the sync cursor trusts.
        .set(toColumns(rest))
        .where(eq(vendors.id, id))
        .returning({ name: vendors.name });

      return rows[0]?.name;
    });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(rest.name));
    return refused(failureText(error));
  }

  if (!name) return refused('That vendor no longer exists.');

  revalidatePath('/vendors');
  return saved(
    `${name} saved. Everything already recorded against them reads the new details, because a record points at this row rather than copying it.`,
  );
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires a vendor, or brings them back.
 *
 * Not a deletion and not a void. A retired vendor stays on the list, keeps
 * their name -- which is why re-adding that name is still refused -- and goes
 * on resolving for every record that names them. What changes is that new
 * work is no longer offered them.
 */
export async function setVendorActive(
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
    .update(vendors)
    .set({ isActive: parsed.data.isActive })
    .where(eq(vendors.id, parsed.data.id))
    .returning({ name: vendors.name, isSubcontractor: vendors.isSubcontractor });

  const row = rows[0];
  if (!row) return refused('That vendor no longer exists.');

  revalidatePath('/vendors');
  return saved(
    parsed.data.isActive
      ? `${row.name} is back on the list for new work.`
      : `${row.name} is retired. They are no longer offered on new work${
          row.isSubcontractor ? ' or on the schedule' : ''
        }, and they still name every record already made against them.`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a vendor as one that should never have existed.
 *
 * The remedy for a name typed twice, or a supplier added on the wrong day
 * before anything was recorded against them. It is not a delete and it does
 * not free the name: the unique index is on `lower(name)`, not on the live
 * rows, so a voided "Sample Supply" still occupies it. That is said out loud
 * in the confirmation, because the obvious next move after voiding is to
 * re-add the corrected record under the same name.
 *
 * See the note at the top of this file: this does NOT yet refuse a vendor
 * other records point at, because no table references `vendors` yet. When
 * `expenses` lands, the count goes inside the transaction below, beside the
 * void, for the reason `voidCostCode` counts inside its own -- the screen was
 * rendered before the expense that now names this vendor was written.
 */
export async function voidVendor(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, VENDOR_LABELS, 'That void needs a reason.');

  let name: string | undefined;
  try {
    const rows = await db
      .update(vendors)
      .set({
        recordStatus: 'void',
        voidedAt: new Date(),
        voidedBy: allowed.actor.id,
        voidReason: parsed.data.reason,
        // `is_active` is deliberately left alone, as `voidCostCode` leaves it
        // alone. The two columns answer two different questions and a void row
        // has not answered the retirement one; every picker in the product
        // therefore filters on BOTH, which is the rule that keeps them from
        // needing to agree.
      })
      .where(eq(vendors.id, parsed.data.id))
      .returning({ name: vendors.name });

    name = rows[0]?.name;
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That vendor no longer exists.');

  revalidatePath('/vendors');
  return saved(
    `${name} is void. Their name stays taken, so a corrected record needs a name of its own.`,
  );
}
