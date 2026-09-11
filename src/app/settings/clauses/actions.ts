'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { quoteClauses } from '@/db/schema';
import { guard } from '@/lib/auth/guard';
import { type ActionResult, refused, saved } from '@/app/settings/result';
import { formValues, invalid } from '@/app/settings/validate';
import {
  CLAUSE_LABELS,
  clauseFields,
  toClauseColumns,
} from '@/app/settings/clauses/schema';

/**
 * The saved exclusions and assumptions, write side.
 *
 * The same three rules as every other maintained list here:
 *
 * 1. **Authorization is a separate lookup, per request.** `guard(...)` reads
 *    the role from `users` every time. The refusal is in the action and not
 *    only in the screen, because a disabled button is a hint and a stale tab
 *    is not obliged to read it.
 * 2. **Nothing is deleted.** `is_active = false` means "stop offering this on
 *    a new quote"; `record_status = 'void'` means "this should never have
 *    existed".
 * 3. **Void carries no in-use guard.** Nothing points at these ids: the quote
 *    stores the TEXT, appended into its own box, never a foreign key -- see
 *    `components/worksheet/ClauseSheet.tsx` for why. So retiring or voiding a
 *    clause cannot change a word of what any existing quote prints, which is
 *    the property that makes editing this list safe at all.
 *
 * `rates:edit` to add, edit and retire; `record:void` to void. The same pair
 * the line group and cost code lists use.
 */

const REFUSAL = 'Your role does not permit changing the saved exclusions and assumptions.';

function failureText(_error: unknown): string {
  // Deliberately not `error.message`: Drizzle wraps a driver error in one
  // whose message is the failed SQL and its parameters, which tells the owner
  // nothing and shows him the schema.
  return 'That change could not be saved. Nothing was written.';
}

export async function createClause(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = clauseFields.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, CLAUSE_LABELS);
  const input = parsed.data;

  try {
    await db.insert(quoteClauses).values({ ...toClauseColumns(input), createdBy: allowed.actor.id });
  } catch (error) {
    return refused(failureText(error));
  }

  revalidatePath('/settings/clauses');
  return saved('Saved. It will be offered on every new quote.');
}

const withId = clauseFields.extend({ id: z.uuid('is not a saved clause') });

/**
 * Edits one in place.
 *
 * A reword reaches every FUTURE quote and no existing one: the quote copied
 * the text when it was added, so a document already printed says what it said.
 * That is the whole reason this list is safe to tidy up.
 */
export async function updateClause(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = withId.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, CLAUSE_LABELS);
  const { id, ...rest } = parsed.data;

  try {
    const rows = await db
      .update(quoteClauses)
      // `updated_at` is deliberately absent: a trigger maintains it, and a
      // value written here would be the one the sync cursor trusts.
      .set(toClauseColumns(rest))
      .where(eq(quoteClauses.id, id))
      .returning({ id: quoteClauses.id });
    if (rows.length === 0) return refused('That clause is no longer on the list.');
  } catch (error) {
    return refused(failureText(error));
  }

  revalidatePath('/settings/clauses');
  return saved('Saved.');
}

const activeSchema = z.object({
  id: z.uuid('is not a saved clause'),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true'),
});

export async function setClauseActive(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('rates:edit');
  if (!allowed.ok) {
    return refused(allowed.error === 'Your role does not permit that.' ? REFUSAL : allowed.error);
  }

  const parsed = activeSchema.safeParse(formValues(formData));
  if (!parsed.success) return refused('That change did not make sense.');
  const { id, isActive } = parsed.data;

  try {
    const rows = await db
      .update(quoteClauses)
      .set({ isActive })
      .where(eq(quoteClauses.id, id))
      .returning({ id: quoteClauses.id });
    if (rows.length === 0) return refused('That clause is no longer on the list.');
  } catch (error) {
    return refused(failureText(error));
  }

  revalidatePath('/settings/clauses');
  return saved(isActive ? 'Back on the list.' : 'Retired. Quotes already carrying it are unchanged.');
}

const voidSchema = z.object({
  id: z.uuid('is not a saved clause'),
  reason: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value !== '', 'is required')
    .refine((value) => value.length <= 300, 'must be 300 characters or fewer'),
});

/**
 * Voids one: for a row that should never have existed.
 *
 * Retiring is the ordinary case and this is not. Kept distinct because the
 * no-DELETE rule means there is no third option, and a list where everything
 * unwanted gets voided loses the distinction between "we stopped saying this"
 * and "this was a mistake".
 */
export async function voidClause(
  _previous: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const allowed = await guard('record:void');
  if (!allowed.ok) {
    return refused(
      allowed.error === 'Your role does not permit that.'
        ? 'Your role does not permit voiding a record.'
        : allowed.error,
    );
  }

  const parsed = voidSchema.safeParse(formValues(formData));
  if (!parsed.success) return invalid(parsed.error, CLAUSE_LABELS);
  const { id, reason } = parsed.data;

  try {
    const rows = await db
      .update(quoteClauses)
      .set({
        recordStatus: 'void',
        voidedAt: new Date(),
        voidedBy: allowed.actor.id,
        voidReason: reason,
        // A void row is also off the list. Both, so nothing has to know that
        // one implies the other.
        isActive: false,
      })
      .where(eq(quoteClauses.id, id))
      .returning({ id: quoteClauses.id });
    if (rows.length === 0) return refused('That clause is no longer on the list.');
  } catch (error) {
    return refused(failureText(error));
  }

  revalidatePath('/settings/clauses');
  return saved('Voided. The reason is kept on the record.');
}
