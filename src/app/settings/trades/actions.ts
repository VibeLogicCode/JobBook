'use server';

import { count, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { trades, vendors } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  TRADE_LABELS,
  isDuplicateName,
  toTradeColumns,
  tradeFields,
} from '@/app/settings/vendor-lists';

/**
 * The trade list's write side.
 *
 * The same three rules that run through `app/settings/cost-codes/actions.ts`
 * run through this file, for the same reasons.
 *
 * 1. **Authorization is a separate lookup, per request.** `guard(...)` reads
 *    the role out of `users` every time; nothing is taken from a form field or
 *    a claim. The refusal lives here rather than only in the screen, because a
 *    disabled button is a hint and a stale tab is not obliged to read it.
 * 2. **Nothing is deleted, and retiring is not voiding.** `is_active = false`
 *    says "do not offer this on new subcontractors" -- a trade this company
 *    has stopped hiring out. `record_status = 'void'` says "this row should
 *    never have existed". Either way `vendors.trade_id` is a foreign key to a
 *    row that never leaves, so retiring "Roofing" does not blank the roofer.
 * 3. **A void is refused for a trade somebody carries**, counted inside the
 *    writing transaction, because the screen was rendered before the sub who
 *    now carries it was hired.
 *
 * A trade carries no rule of its own -- it is what you call somebody when you
 * are looking for one, and nothing about a filing turns on it. That is why
 * this file is the plain half of the pair and `vendor-types/actions.ts` is
 * not: the thing that decides who is owed a T5018 lives there, on a flag that
 * cannot be edited at all.
 *
 * `rates:edit` for adding, editing and retiring; `record:void` for voiding.
 * Both follow the cost code list and the vendor directory.
 */

const REFUSAL = 'Your role does not permit changing the trade list.';

/** A void refused because the row is doing work, carried out as a sentence. */
class InUseError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof InUseError) return error.message;
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
      name: trades.name,
      isActive: trades.isActive,
      recordStatus: trades.recordStatus,
    })
    .from(trades)
    .where(sql`lower(${trades.name}) = lower(${name})`);

  if (!row) return `${name} is already taken.`;
  if (row.recordStatus === 'void') {
    // Not "edit that one": a void row is kept as a record and is not edited.
    return `${row.name} is held by a voided row. Voiding does not free a name, because the unique index is on the column and not on the live rows, so a corrected trade needs a name of its own.`;
  }
  if (!row.isActive) {
    return `${row.name} is already on the list as a retired trade. Bring that one back rather than adding a second row — every subcontractor already filed under it is on the row that exists.`;
  }
  return `${row.name} is already on the list. Edit that one, or choose another name.`;
}

/* -------------------------------------------------------------------------
   One trade at a time
   ------------------------------------------------------------------------- */

export async function createTrade(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = tradeFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TRADE_LABELS);
  const input = parsed.data;

  try {
    await db
      .insert(trades)
      .values({ ...toTradeColumns(input), createdBy: allowed.actor.id });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(input.name));
    return refused(failureText(error));
  }

  revalidatePath('/settings/trades');
  revalidatePath('/vendors');
  return saved(`${input.name} added.`);
}

const withId = tradeFields.extend({ id: z.uuid('is not a trade') });

/**
 * Edits a trade in place.
 *
 * In place, and not a supersede-with-dates the way a tax rate works. A trade
 * is a label: renaming "Drywall" to "Drywall and taping" is the same trade,
 * and every subcontractor already filed under it should read the new name.
 *
 * What must never happen is the row being quietly reused for a DIFFERENT
 * trade -- renaming "Roofing" to "Siding" because the roofer left -- which
 * relabels everybody already on it rather than recording a change. The screen
 * says so beside the form, and retire is the control for a trade this company
 * has stopped hiring.
 */
export async function updateTrade(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TRADE_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    const rows = await db
      .update(trades)
      // `updated_at` is deliberately absent: a trigger maintains it, and a
      // value written here would be the one the sync cursor trusts.
      .set(toTradeColumns(rest))
      .where(eq(trades.id, id))
      .returning({ name: trades.name });
    name = rows[0]?.name;
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(rest.name));
    return refused(failureText(error));
  }

  if (!name) return refused('That trade no longer exists.');

  revalidatePath('/settings/trades');
  revalidatePath('/vendors');
  return saved(`${name} saved.`);
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires a trade, or brings it back.
 *
 * Not a deletion and not a void. A retired trade stays on the list, keeps its
 * name -- which is why re-adding that name is still refused -- and goes on
 * resolving for every subcontractor who carries it. What changes is that it is
 * no longer offered when a new subcontractor is added.
 */
export async function setTradeActive(
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
    .update(trades)
    .set({ isActive: parsed.data.isActive })
    .where(eq(trades.id, parsed.data.id))
    .returning({ name: trades.name });

  const row = rows[0];
  if (!row) return refused('That trade no longer exists.');

  const [stillOn] = await db
    .select({ n: count() })
    .from(vendors)
    .where(eq(vendors.tradeId, parsed.data.id));

  revalidatePath('/settings/trades');
  revalidatePath('/vendors');
  return saved(
    parsed.data.isActive
      ? `${row.name} is back on the list.`
      : `${row.name} is retired.${
          (stillOn?.n ?? 0) > 0
            ? ` ${stillOn?.n} ${stillOn?.n === 1 ? 'subcontractor' : 'subcontractors'} still ${stillOn?.n === 1 ? 'shows' : 'show'} it.`
            : ''
        }`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a trade as one that should never have existed.
 *
 * The remedy for a name typed twice, or a trade added under a spelling nobody
 * uses before any subcontractor was put on it. It is not a delete and it does
 * not free the name.
 *
 * Refused for a trade any vendor carries, counted inside the writing
 * transaction rather than read off the screen -- the screen was rendered
 * before the sub who now carries it was hired. The refusal follows
 * `voidCostCode`: a row that is doing work was not a mistake, and Retire is
 * the control for taking it out of circulation.
 */
export async function voidTrade(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, TRADE_LABELS, 'That void needs a reason.');

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      const [inUse] = await tx
        .select({ n: count() })
        .from(vendors)
        .where(eq(vendors.tradeId, parsed.data.id));

      if ((inUse?.n ?? 0) > 0) {
        throw new InUseError(
          `${inUse?.n} ${inUse?.n === 1 ? 'subcontractor carries' : 'subcontractors carry'} this trade, so it is not a row that should never have existed. Retire it instead: that stops it being offered when somebody new is added, and everybody already on it goes on showing it.`,
        );
      }

      const rows = await tx
        .update(trades)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
          // `is_active` is deliberately left alone, as `voidCostCode` leaves
          // it alone. The two columns answer two different questions, and
          // every picker filters on BOTH.
        })
        .where(eq(trades.id, parsed.data.id))
        .returning({ name: trades.name });

      return rows[0]?.name;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That trade no longer exists.');

  revalidatePath('/settings/trades');
  revalidatePath('/vendors');
  return saved(`${name} is void. Its name stays taken.`);
}
