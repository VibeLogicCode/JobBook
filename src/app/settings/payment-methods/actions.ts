'use server';

import { count, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { expenses, paymentMethods } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  PAYMENT_METHOD_LABELS,
  isDuplicateName,
  newPaymentMethodFields,
  toPaymentMethodColumns,
  paymentMethodFields,
} from '@/app/settings/payment-methods/schema';

/**
 * The payment method list's write side.
 *
 * The same three rules that run through `vendor-types/actions.ts` run through
 * this file, for the same reasons -- read that file's header before this one.
 *
 * What is different here, and is the point of the whole screen: there is no
 * path that writes `is_on_account`. `createPaymentMethod` sets it once from
 * the form; `updatePaymentMethod` parses a shape that does not contain it and
 * writes a column map that cannot express it. A method whose flag is wrong is
 * retired and replaced, exactly as a vendor type whose subcontractor answer is
 * wrong is.
 *
 * `rates:edit` is the capability for adding, editing and retiring, and
 * `record:void` gates voiding -- the same pair every maintained list in this
 * product uses.
 */

const REFUSAL = 'Your role does not permit changing the payment method list.';

/** A void refused because the row is doing work, carried out as a sentence. */
class InUseError extends Error {}

function failureText(error: unknown): string {
  if (error instanceof InUseError) return error.message;
  // Deliberately NOT `error.message`. Drizzle wraps a driver error in a
  // DrizzleQueryError whose message is the failed SQL and its bound
  // parameters. Putting that on the screen tells the owner nothing he can act
  // on and shows him the schema; the server log still has the whole thing.
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
      name: paymentMethods.name,
      isActive: paymentMethods.isActive,
      recordStatus: paymentMethods.recordStatus,
      isOnAccount: paymentMethods.isOnAccount,
    })
    .from(paymentMethods)
    .where(sql`lower(${paymentMethods.name}) = lower(${name})`);

  if (!row) return `${name} is already taken.`;
  const means = row.isOnAccount
    ? 'means the money has not left yet'
    : 'settles immediately';

  if (row.recordStatus === 'void') {
    return `${row.name} is held by a voided row. Voiding does not free a name, because the unique index is on the column and not on the live rows, so a corrected method needs a name of its own.`;
  }
  if (!row.isActive) {
    return `${row.name} is already on the list as a retired method, and it ${means}. Bring that one back if it is the same method; add a differently named one if it is not.`;
  }
  return `${row.name} is already on the list, and it ${means}. Edit that one, or choose another name.`;
}

/* -------------------------------------------------------------------------
   One method at a time
   ------------------------------------------------------------------------- */

/**
 * Adds a method, and this is the ONLY place `is_on_account` is ever decided.
 *
 * Once, at creation, and never again -- which is what makes the list
 * maintainable without making "has this been paid" editable by a rename.
 */
export async function createPaymentMethod(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = newPaymentMethodFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, PAYMENT_METHOD_LABELS);
  const input = parsed.data;

  try {
    await db.insert(paymentMethods).values({
      name: input.name,
      sortOrder: input.sortOrder,
      isOnAccount: input.isOnAccount,
      createdBy: allowed.actor.id,
    });
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(input.name));
    return refused(failureText(error));
  }

  revalidatePath('/settings/payment-methods');
  revalidatePath('/expenses');
  return saved(
    `${input.name} added${input.isOnAccount ? ', meaning the money has not left yet' : ''}. This cannot be changed later.`,
  );
}

const withId = paymentMethodFields.extend({ id: z.uuid('is not a payment method') });

/**
 * Edits a method in place -- its NAME and its order, and nothing else.
 *
 * A rename reaches every expense filed under it. What it explicitly does NOT
 * do is move any expense on or off "not yet paid": the shape parsed here has
 * no `isOnAccount` and the column map cannot express one.
 */
export async function updatePaymentMethod(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, PAYMENT_METHOD_LABELS);
  const { id, ...rest } = parsed.data;

  let name: string | undefined;
  try {
    const rows = await db
      .update(paymentMethods)
      // `updated_at` is deliberately absent: a trigger maintains it.
      .set(toPaymentMethodColumns(rest))
      .where(eq(paymentMethods.id, id))
      .returning({ name: paymentMethods.name });
    name = rows[0]?.name;
  } catch (error) {
    if (isDuplicateName(error)) return refused(await takenBy(rest.name));
    return refused(failureText(error));
  }

  if (!name) return refused('That payment method no longer exists.');

  revalidatePath('/settings/payment-methods');
  revalidatePath('/expenses');
  return saved(`${name} saved.`);
}

const activeFields = z.object({ id: z.uuid(), isActive: z.stringbool() });

/**
 * Retires a method, or brings it back.
 *
 * Not a deletion and not a void. A retired method stays on the list, keeps
 * its name, and goes on resolving for every expense already recorded against
 * it. What changes is that new expenses are no longer offered it.
 */
export async function setPaymentMethodActive(
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
    .update(paymentMethods)
    .set({ isActive: parsed.data.isActive })
    .where(eq(paymentMethods.id, parsed.data.id))
    .returning({ name: paymentMethods.name });

  const row = rows[0];
  if (!row) return refused('That payment method no longer exists.');

  revalidatePath('/settings/payment-methods');
  revalidatePath('/expenses');
  return saved(
    parsed.data.isActive ? `${row.name} is back on the list.` : `${row.name} is retired.`,
  );
}

const voidFields = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(1, 'is required').max(300, 'must be 300 characters or fewer'),
});

/**
 * Marks a method as one that should never have existed.
 *
 * Refused for a method any expense is recorded against, counted inside the
 * writing transaction rather than read off the screen -- the screen was
 * rendered before the expense that now uses this method was added.
 */
export async function voidPaymentMethod(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) return refused(allowed.error);

  const parsed = voidFields.safeParse(formValues(formData));
  if (!parsed.success) {
    return invalid(parsed.error, PAYMENT_METHOD_LABELS, 'That void needs a reason.');
  }

  let name: string | undefined;
  try {
    name = await db.transaction(async (tx) => {
      const [inUse] = await tx
        .select({ n: count() })
        .from(expenses)
        .where(eq(expenses.paymentMethodId, parsed.data.id));

      if ((inUse?.n ?? 0) > 0) {
        throw new InUseError(
          `${inUse?.n} ${inUse?.n === 1 ? 'expense is' : 'expenses are'} recorded against this method, so it is not a row that should never have existed. Retire it instead: that stops it being offered on new expenses and leaves everything already on it exactly as it is.`,
        );
      }

      const rows = await tx
        .update(paymentMethods)
        .set({
          recordStatus: 'void',
          voidedAt: new Date(),
          voidedBy: allowed.actor.id,
          voidReason: parsed.data.reason,
          // `is_active` is deliberately left alone -- the two columns answer
          // two different questions, and a void row has not answered the
          // retirement one.
        })
        .where(eq(paymentMethods.id, parsed.data.id))
        .returning({ name: paymentMethods.name });

      return rows[0]?.name;
    });
  } catch (error) {
    return refused(failureText(error));
  }

  if (!name) return refused('That payment method no longer exists.');

  revalidatePath('/settings/payment-methods');
  revalidatePath('/expenses');
  return saved(`${name} is void. Its name stays taken.`);
}
